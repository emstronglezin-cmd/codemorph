// ============================================================
// CodeMorph — Uploads Service
// FIX: Ajout downloadFromUrl() pour mode URL_IMPORT
// ============================================================
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import AdmZip from 'adm-zip';

export interface RepoFile {
  path: string;
  content: string;
}

const MAX_ZIP_SIZE       = 50 * 1024 * 1024; // 50MB
const MAX_FILES          = 500;
const MAX_DOWNLOAD_SIZE  = 50 * 1024 * 1024; // 50MB for URL downloads
const MAX_REDIRECTS      = 5;

const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.dart', '.py', '.go',
  '.java', '.kt', '.swift', '.cs', '.rs', '.rb', '.php',
  '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.scss', '.md',
];
const IGNORED_PATHS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly uploadDir: string;

  constructor(private readonly configService: ConfigService) {
    this.uploadDir = this.configService.get<string>('UPLOAD_DIR', '/tmp/codemorph-uploads');
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  // ── Save uploaded file from memory ────────────────────
  saveUploadedFile(file: Express.Multer.File): { path: string; size: number; name: string } {
    if (file.size > MAX_ZIP_SIZE) {
      throw new BadRequestException({
        code:    'UPLOAD_TOO_LARGE',
        message: `File too large. Maximum size is ${MAX_ZIP_SIZE / 1024 / 1024}MB`,
      });
    }
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      throw new BadRequestException({
        code:    'UPLOAD_INVALID_TYPE',
        message: 'Only ZIP files are accepted',
      });
    }

    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`;
    const filePath = path.join(this.uploadDir, safeName);
    fs.writeFileSync(filePath, file.buffer);
    this.logger.log(`Saved upload: ${filePath} (${file.size} bytes)`);

    return { path: filePath, size: file.size, name: file.originalname };
  }

  // ── Download ZIP from public URL ───────────────────────
  async downloadFromUrl(url: string): Promise<string> {
    this.logger.log(`Downloading ZIP from URL: ${url}`);

    const buffer = await this.fetchUrl(url, 0);

    // Validate ZIP magic bytes
    if (buffer.length < 4 || !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      throw new BadRequestException({
        code:    'URL_NOT_ZIP',
        message: `The URL does not point to a valid ZIP file. ` +
                 `Expected ZIP magic bytes (PK), got: ${buffer.slice(0, 4).toString('hex')}. ` +
                 `For GitHub repos, use the archive URL: https://github.com/OWNER/REPO/archive/refs/heads/BRANCH.zip`,
      });
    }

    if (buffer.length > MAX_DOWNLOAD_SIZE) {
      throw new BadRequestException({
        code:    'URL_TOO_LARGE',
        message: `Downloaded file exceeds maximum size of ${MAX_DOWNLOAD_SIZE / 1024 / 1024}MB.`,
      });
    }

    const safeName = `url-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`;
    const filePath = path.join(this.uploadDir, safeName);
    fs.writeFileSync(filePath, buffer);

    this.logger.log(`Downloaded and saved: ${filePath} (${buffer.length} bytes)`);
    return filePath;
  }

  // ── HTTP fetch with redirect follow ───────────────────
  private fetchUrl(url: string, redirectCount: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (redirectCount > MAX_REDIRECTS) {
        return reject(new BadRequestException({
          code:    'URL_TOO_MANY_REDIRECTS',
          message: `Too many redirects (>${MAX_REDIRECTS}) when downloading from URL.`,
        }));
      }

      const parsedUrl = new URL(url);
      const proto     = parsedUrl.protocol === 'https:' ? https : http;
      const chunks: Buffer[] = [];
      let totalSize = 0;

      const req = proto.get(url, {
        timeout: 30_000,
        headers: {
          'User-Agent': 'CodeMorph/1.0 (https://codemorph.dev)',
          'Accept':     'application/zip, application/octet-stream, */*',
        },
      }, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.logger.log(`Redirect ${res.statusCode} → ${res.headers.location}`);
          return resolve(this.fetchUrl(res.headers.location, redirectCount + 1));
        }

        if (res.statusCode && res.statusCode !== 200) {
          return reject(new BadRequestException({
            code:    'URL_DOWNLOAD_FAILED',
            message: `Failed to download from URL: HTTP ${res.statusCode}. ` +
                     `Ensure the URL is publicly accessible and points to a ZIP file.`,
          }));
        }

        // Check content-length
        const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
        if (contentLength > MAX_DOWNLOAD_SIZE) {
          res.destroy();
          return reject(new BadRequestException({
            code:    'URL_TOO_LARGE',
            message: `File at URL is too large (${(contentLength / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.`,
          }));
        }

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_DOWNLOAD_SIZE) {
            res.destroy();
            reject(new BadRequestException({
              code:    'URL_TOO_LARGE',
              message: 'Download size limit exceeded (50MB).',
            }));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => reject(new BadRequestException({
          code:    'URL_DOWNLOAD_ERROR',
          message: `Download error: ${err.message}`,
        })));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new BadRequestException({
          code:    'URL_DOWNLOAD_TIMEOUT',
          message: 'Download timed out after 30 seconds. The URL may be slow or unavailable.',
        }));
      });

      req.on('error', (err) => reject(new BadRequestException({
        code:    'URL_CONNECTION_ERROR',
        message: `Could not connect to URL: ${err.message}`,
      })));
    });
  }

  // ── Extract ZIP files ──────────────────────────────────
  async extractZipFiles(zipPath: string): Promise<RepoFile[]> {
    if (!fs.existsSync(zipPath)) {
      throw new BadRequestException({
        code:    'ZIP_NOT_FOUND',
        message: `ZIP file not found: ${zipPath}. The file may have been deleted or the path is incorrect.`,
      });
    }

    this.logger.log(`Extracting ZIP: ${zipPath}`);

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipPath);
    } catch (e) {
      throw new BadRequestException({
        code:    'ZIP_CORRUPT',
        message: `Could not open ZIP file: ${(e as Error).message}. Ensure the file is a valid ZIP archive.`,
      });
    }

    const entries = zip.getEntries();
    const files: RepoFile[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (files.length >= MAX_FILES) {
        this.logger.warn(`ZIP contains more than ${MAX_FILES} files — truncating`);
        break;
      }

      const entryPath = entry.entryName;

      // Skip ignored paths
      if (IGNORED_PATHS.some((p) => entryPath.includes(p))) continue;

      // Skip non-code files
      const ext = path.extname(entryPath).toLowerCase();
      if (!CODE_EXTENSIONS.includes(ext)) continue;

      // Skip large files
      if (entry.header.size > 500 * 1024) {
        this.logger.warn(`Skipping large file: ${entryPath} (${entry.header.size} bytes)`);
        continue;
      }

      try {
        const content = entry.getData().toString('utf-8');
        // Strip leading directory (GitHub zip convention: repo-name-branch/...)
        const normalizedPath = entryPath.replace(/^[^/]+\//, '');
        files.push({ path: normalizedPath, content });
      } catch {
        this.logger.warn(`Could not read entry: ${entryPath}`);
      }
    }

    this.logger.log(`Extracted ${files.length} files from ZIP (total entries: ${entries.length})`);

    if (files.length === 0) {
      throw new BadRequestException({
        code:    'ZIP_EMPTY',
        message: 'No source code files found in the ZIP archive. ' +
                 'Ensure the ZIP contains code files (.ts, .tsx, .js, .dart, etc.) ' +
                 'and does not only contain node_modules, build/, or dist/.',
      });
    }

    // Clean up after extraction
    try {
      fs.unlinkSync(zipPath);
      this.logger.debug(`Cleaned up ZIP: ${zipPath}`);
    } catch {
      this.logger.warn(`Could not delete ZIP: ${zipPath}`);
    }

    return files;
  }

  cleanupFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      this.logger.warn(`Could not cleanup file: ${filePath}`);
    }
  }
}
