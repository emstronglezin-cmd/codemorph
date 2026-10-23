import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

import { TaskTile } from '../TaskTile';
import type { Task } from '../../types/task.types';

const task = (over: Partial<Task> = {}): Task => ({ id: 't1', title: 'Acheter du pain', isDone: false, ...over });

describe('TaskTile — affichage et complétion', () => {
  it('affiche le titre de la tâche', () => {
    render(<TaskTile task={task()} onToggle={jest.fn()} />);
    expect(screen.getByTestId('task-title-t1').props.children).toBe('Acheter du pain');
  });

  it('appelle onToggle avec l\'identifiant, jamais une fonction', () => {
    const onToggle = jest.fn();
    render(<TaskTile task={task({ id: 't2' })} onToggle={onToggle} />);
    fireEvent.press(screen.getByTestId('task-toggle-t2'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('t2');
  });

  it('reflète isDone sur l\'accessibilité', () => {
    const { rerender } = render(<TaskTile task={task({ id: 't3' })} onToggle={jest.fn()} />);
    expect(screen.getByTestId('task-toggle-t3').props.accessibilityState)
      .toEqual(expect.objectContaining({ checked: false }));

    rerender(<TaskTile task={task({ id: 't3', isDone: true })} onToggle={jest.fn()} />);
    expect(screen.getByTestId('task-toggle-t3').props.accessibilityState)
      .toEqual(expect.objectContaining({ checked: true }));
  });

  it('barre le titre quand la tâche est terminée', () => {
    render(<TaskTile task={task({ id: 't4', isDone: true })} onToggle={jest.fn()} />);
    const style = screen.getByTestId('task-title-t4').props.style;
    const flat = Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean));
    expect(flat.textDecorationLine).toBe('line-through');
  });
});
