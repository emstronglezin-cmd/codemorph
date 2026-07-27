// ============================================================
// CodeMorph — QueueModule
// PHASE 26.1 — MemoryQueueProvider uniquement
//
// Ce module fournit uniquement MemoryQueueProvider.
// QueueAdapterService est dans JobsModule (qui a accès à BullModule).
//
// Évite la dépendance circulaire et les problèmes de scope NestJS.
// ============================================================
import { Module } from '@nestjs/common';

import { MemoryQueueProvider } from './memory-queue.provider';

@Module({
  providers: [MemoryQueueProvider],
  exports:   [MemoryQueueProvider],
})
export class QueueModule {}
