// ============================================================
// CodeMorph — Uploads Controller
// FIX: FileTypeValidator étendu pour accepter tous les MIME ZIP
// Les navigateurs/OS envoient parfois application/x-zip-compressed
// ou application/octet-stream au lieu de application/zip
// ============================================================
import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UploadsService } from './uploads.service';

// Accepted MIME types for ZIP files (browser/OS variations)
const ACCEPTED_ZIP_MIMES = [
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'application/x-compressed',
  'multipart/x-zip',
];

const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB

@ApiTags('uploads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(private readonly uploadsService: UploadsService) {}

  @Post('zip')
  @ApiOperation({ summary: 'Upload a ZIP file containing source code' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadZip(
    @UploadedFile() file: Express.Multer.File,
  ) {
    // Manual validation — more flexible than ParseFilePipe + FileTypeValidator
    if (!file) {
      throw new BadRequestException({
        code:    'UPLOAD_MISSING',
        message: 'No file uploaded. Please provide a ZIP file in the "file" field.',
      });
    }

    this.logger.log(
      `Upload received: name="${file.originalname}" mime="${file.mimetype}" size=${file.size}`,
    );

    // Validate file size
    if (file.size > MAX_ZIP_SIZE) {
      throw new BadRequestException({
        code:    'UPLOAD_TOO_LARGE',
        message: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.`,
      });
    }

    // Validate MIME type — accept all ZIP-like MIME types
    const mimeOk = ACCEPTED_ZIP_MIMES.includes(file.mimetype);
    // Also accept if filename ends with .zip (some browsers don't set MIME correctly)
    const extOk  = file.originalname.toLowerCase().endsWith('.zip');

    if (!mimeOk && !extOk) {
      throw new BadRequestException({
        code:    'UPLOAD_INVALID_TYPE',
        message: `Only ZIP files are accepted. Received MIME type: "${file.mimetype}". ` +
                 `Ensure your file has a .zip extension.`,
      });
    }

    // Validate ZIP magic bytes (PK\x03\x04) — prevent fake ZIP uploads
    if (file.buffer.length >= 4) {
      const magic = file.buffer.slice(0, 4);
      const isZip = magic[0] === 0x50 && magic[1] === 0x4b &&
                    (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07);
      if (!isZip) {
        throw new BadRequestException({
          code:    'UPLOAD_NOT_ZIP',
          message: 'File does not appear to be a valid ZIP archive (invalid magic bytes).',
        });
      }
    }

    this.logger.log(`Saving upload: ${file.originalname} (${file.size} bytes)`);
    const saved = this.uploadsService.saveUploadedFile(file);

    this.logger.log(`Upload saved at: ${saved.path}`);

    return {
      zipPath:   saved.path,
      fileName:  saved.name,
      sizeBytes: saved.size,
    };
  }
}
