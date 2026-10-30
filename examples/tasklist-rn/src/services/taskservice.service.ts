// TaskService — service local généré depuis la source Dart.
// Aucune API REST n'est inventée : la source est une classe côté client.
import type { Task } from '../types/task.types';

export type TaskServiceListener = (items: readonly Task[]) => void;

export class TaskService {
  private tasks: Task[] = [];
  private readonly listeners = new Set<TaskServiceListener>();

  /** Copie défensive en lecture seule — équivalent de List.unmodifiable. */
  getAll(): readonly Task[] {
    return [...this.tasks];
  }

  /** Crée et enregistre un nouvel élément. */
  add(title: string): Task {
    const created: Task = {
      id: this.nextId(),
      title,
      isDone: false,
    };
    this.tasks = [...this.tasks, created];
    this.notify();
    return created;
  }

  /** Inverse l'état « isDone » — équivalent du copyWith de la source. */
  toggle(id: string): void {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index < 0) return;
    const current = this.tasks[index];
    if (!current) return;
    this.tasks = this.tasks.map((t, i) =>
      i === index ? { ...t, isDone: !t.isDone } : t);
    this.notify();
  }

  /** Nombre d'éléments dont « isDone » est vrai. */
  get isDoneCount(): number {
    return this.tasks.filter((t) => t.isDone).length;
  }

  /** Supprime l'élément correspondant. */
  remove(id: string): void {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length !== before) this.notify();
  }

  get totalCount(): number {
    return this.tasks.length;
  }

  subscribe(listener: TaskServiceListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    const snapshot = this.getAll();
    for (const listener of this.listeners) listener(snapshot);
  }

  private nextId(): string {
    // Identifiant texte : préfixe lisible + horodatage + aléa.
    return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Réinitialisation — utilisée par les tests. */
  reset(): void {
    this.tasks = [];
    this.notify();
  }
}

/** Instance partagée par l'application. */
export const taskService = new TaskService();
