/**
 * Test de flux — ajout, affichage, complétion.
 * Aucun appareil ni émulateur : ces tests s'exécutent dans le renderer de test
 * React Native et ne prouvent PAS un rendu sur appareil.
 */
import React from 'react';
import {
  act, render, screen, fireEvent, waitFor,
} from '@testing-library/react-native';

const mockBack = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return {
    useRouter: () => ({ back: mockBack, push: mockPush, replace: jest.fn() }),
    Stack: Object.assign(
      ({ children }: { children?: React.ReactNode }) => ReactLib.createElement(View, null, children),
      { Screen: () => null },
    ),
  };
});

import AddTaskScreen from '../add-task';
import HomeScreen from '../index';
import { taskService } from '../../src/services/taskservice.service';

describe('Flux liste de tâches', () => {
  beforeEach(() => {
    taskService.reset();
    mockBack.mockClear();
    mockPush.mockClear();
  });

  describe('1. Ajout depuis le formulaire', () => {
    it('crée la tâche et revient en arrière après validation', () => {
      render(<AddTaskScreen />);
      fireEvent.changeText(screen.getByTestId('task-title-input'), 'Acheter du pain');
      fireEvent.press(screen.getByTestId('submit-task-button'));

      expect(taskService.getAll()).toHaveLength(1);
      expect(taskService.getAll()[0]?.title).toBe('Acheter du pain');
      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    it('refuse un titre vide et reste sur l\'écran', () => {
      render(<AddTaskScreen />);
      fireEvent.changeText(screen.getByTestId('task-title-input'), '   ');
      fireEvent.press(screen.getByTestId('submit-task-button'));

      expect(screen.getByTestId('form-error').props.children).toMatch(/vide/);
      expect(taskService.getAll()).toHaveLength(0);
      expect(mockBack).not.toHaveBeenCalled();
    });

    it('ne transmet aucune fonction par la navigation', () => {
      render(<AddTaskScreen />);
      fireEvent.changeText(screen.getByTestId('task-title-input'), 'Sans callback');
      fireEvent.press(screen.getByTestId('submit-task-button'));
      expect(mockBack).toHaveBeenCalledWith();
    });
  });

  describe('2. Affichage sur l\'écran d\'accueil', () => {
    it('affiche immédiatement la tâche ajoutée depuis le formulaire', async () => {
      const form = render(<AddTaskScreen />);
      fireEvent.changeText(screen.getByTestId('task-title-input'), 'Préparer la démo');
      fireEvent.press(screen.getByTestId('submit-task-button'));
      form.unmount();

      render(<HomeScreen />);
      await waitFor(() => { expect(screen.queryByTestId('state-loading')).toBeNull(); });

      expect(screen.getByText('Préparer la démo')).toBeTruthy();
      expect(screen.getByText('0 / 1 terminées')).toBeTruthy();
    });

    it('affiche l\'état vide quand il n\'y a aucune tâche', async () => {
      render(<HomeScreen />);
      await waitFor(() => { expect(screen.getByTestId('state-empty')).toBeTruthy(); });
      expect(screen.getByText('0 / 0 terminées')).toBeTruthy();
    });

    it('affiche une tâche ajoutée pendant que l\'écran est ouvert', async () => {
      render(<HomeScreen />);
      await waitFor(() => { expect(screen.getByTestId('state-empty')).toBeTruthy(); });

      act(() => { taskService.add('Ajoutée en direct'); });

      await waitFor(() => { expect(screen.getByText('Ajoutée en direct')).toBeTruthy(); });
    });
  });

  describe('3. Complétion et compteur', () => {
    it('met à jour la tâche et le compteur au toggle', async () => {
      const first = taskService.add('Terminer le rapport');
      taskService.add('Relire');

      render(<HomeScreen />);
      await waitFor(() => { expect(screen.getByText('0 / 2 terminées')).toBeTruthy(); });

      fireEvent.press(screen.getByTestId(`task-toggle-${first.id}`));
      await waitFor(() => { expect(screen.getByText('1 / 2 terminées')).toBeTruthy(); });
      expect(taskService.getAll().find((t) => t.id === first.id)?.isDone).toBe(true);

      fireEvent.press(screen.getByTestId(`task-toggle-${first.id}`));
      await waitFor(() => { expect(screen.getByText('0 / 2 terminées')).toBeTruthy(); });
    });
  });

  describe('4. Navigation', () => {
    it('ouvre le formulaire d\'ajout depuis l\'écran d\'accueil', async () => {
      render(<HomeScreen />);
      await waitFor(() => { expect(screen.queryByTestId('state-loading')).toBeNull(); });

      fireEvent.press(screen.getByTestId('add-task-button'));
      expect(mockPush).toHaveBeenCalledWith('/add-task');
    });
  });
});
