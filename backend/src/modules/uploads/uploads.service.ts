import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

export interface RepoFile {
  path: string;
  content: string;
}

const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_FILES = 500;
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

  saveUploadedFile(file: Express.Multer.File): { path: string; size: number; name: string } {
    if (file.size > MAX_ZIP_SIZE) {
      throw new BadRequestException(`File too large. Maximum size is ${MAX_ZIP_SIZE / 1024 / 1024}MB`);
    }
    if (!file.originalname.endsWith('.zip')) {
      throw new BadRequestException('Only ZIP files are accepted');
    }

    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`;
    const filePath = path.join(this.uploadDir, safeName);
    fs.writeFileSync(filePath, file.buffer);
    this.logger.log(`Saved upload: ${filePath} (${file.size} bytes)`);

    return { path: filePath, size: file.size, name: file.originalname };
  }

  async extractZipFiles(zipPath: string): Promise<RepoFile[]> {
    if (!fs.existsSync(zipPath)) {
      throw new BadRequestException(`ZIP file not found: ${zipPath}`);
    }

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const files: RepoFile[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (files.length >= MAX_FILES) break;

      const entryPath = entry.entryName;

      // Skip ignored paths
      if (IGNORED_PATHS.some((p) => entryPath.includes(p))) continue;

      // Skip non-code files
      const ext = path.extname(entryPath).toLowerCase();
      if (!CODE_EXTENSIONS.includes(ext)) continue;

      // Skip large files
      if (entry.header.size > 500 * 1024) continue;

      try {
        const content = entry.getData().toString('utf-8');
        // Strip leading directory (GitHub zip convention: repo-name-branch/...)
        const normalizedPath = entryPath.replace(/^[^/]+\//, '');
        files.push({ path: normalizedPath, content });
      } catch {
        this.logger.warn(`Could not read entry: ${entryPath}`);
      }
    }

    this.logger.log(`Extracted ${files.length} files from ZIP`);

    // Clean up after extraction
    try {
      fs.unlinkSync(zipPath);
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
