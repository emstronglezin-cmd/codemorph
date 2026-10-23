import { TaskService } from '../taskservice.service';

describe('TaskService — logique métier (conversion de task_service.dart)', () => {
  let service: TaskService;
  beforeEach(() => { service = new TaskService(); });

  it('ajoute une tâche et la retourne avec isDone à false', () => {
    const task = service.add('Acheter du pain');
    expect(task.title).toBe('Acheter du pain');
    expect(task.isDone).toBe(false);
    expect(service.getAll()).toHaveLength(1);
  });

  it('donne un identifiant unique à chaque tâche', () => {
    expect(service.add('A').id).not.toBe(service.add('B').id);
  });

  it('toggle inverse isDone et met à jour le compteur', () => {
    const task = service.add('Écrire le rapport');
    expect(service.isDoneCount).toBe(0);

    service.toggle(task.id);
    expect(service.getAll()[0]?.isDone).toBe(true);
    expect(service.isDoneCount).toBe(1);

    service.toggle(task.id);
    expect(service.getAll()[0]?.isDone).toBe(false);
    expect(service.isDoneCount).toBe(0);
  });

  it('compte uniquement les tâches terminées', () => {
    const a = service.add('A');
    service.add('B');
    const c = service.add('C');
    service.toggle(a.id);
    service.toggle(c.id);
    expect(service.isDoneCount).toBe(2);
    expect(service.totalCount).toBe(3);
  });

  it('ignore un identifiant inconnu sans lever', () => {
    service.add('A');
    expect(() => service.toggle('inexistant')).not.toThrow();
    expect(service.isDoneCount).toBe(0);
  });

  it('getAll retourne une copie défensive', () => {
    service.add('A');
    expect(service.getAll()).not.toBe(service.getAll());
  });

  it('notifie les abonnés et permet de se désabonner', () => {
    const seen: number[] = [];
    const unsubscribe = service.subscribe((items) => seen.push(items.length));
    service.add('A');
    service.add('B');
    const first = service.getAll()[0];
    if (first) service.toggle(first.id);
    expect(seen).toEqual([1, 2, 2]);

    unsubscribe();
    service.add('C');
    expect(seen).toHaveLength(3);
  });

  it('remove supprime la tâche ciblée', () => {
    const a = service.add('A');
    service.add('B');
    service.remove(a.id);
    expect(service.totalCount).toBe(1);
    expect(service.getAll()[0]?.title).toBe('B');
  });
});
