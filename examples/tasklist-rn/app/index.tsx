import React, {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import {
  ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { TaskTile } from '../src/components/TaskTile';
import type { Task } from '../src/types/task.types';
import { taskService } from '../src/services/taskservice.service';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * Écran d'accueil — conversion de `lib/screens/home_screen.dart`.
 * C'est `app/index.tsx`, donc la route `/` : l'accueil s'ouvre au démarrage
 * sans redirection intermédiaire.
 */
export default function HomeScreen(): React.JSX.Element {
  const router = useRouter();
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    setErrorMessage(null);
    try {
      setTasks(taskService.getAll());
      setState('ready');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Chargement impossible');
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
    // L'écran d'ajout modifie le service puis revient en arrière :
    // l'abonnement affiche la nouvelle tâche immédiatement.
    return taskService.subscribe(setTasks);
  }, [load]);

  const handleToggle = useCallback((id: string): void => {
    taskService.toggle(id);
  }, []);

  const completed = useMemo(() => tasks.filter((t) => t.isDone).length, [tasks]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'Mes tâches' }} />

      <View style={styles.counterBar}>
        <Text style={styles.counter} testID="task-counter">
          {completed} / {tasks.length} terminées
        </Text>
      </View>

      {state === 'loading' ? (
        <View style={styles.center} testID="state-loading">
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.hint}>Chargement des tâches…</Text>
        </View>
      ) : null}

      {state === 'error' ? (
        <View style={styles.center} testID="state-error">
          <Text style={styles.errorTitle}>Impossible de charger les tâches</Text>
          <Text style={styles.hint}>{errorMessage}</Text>
          <Pressable style={styles.retry} onPress={() => void load()} testID="retry-button">
            <Text style={styles.retryLabel}>Réessayer</Text>
          </Pressable>
        </View>
      ) : null}

      {state === 'ready' && tasks.length === 0 ? (
        <View style={styles.center} testID="state-empty">
          <Text style={styles.emptyTitle}>Aucune tâche</Text>
          <Text style={styles.hint}>Appuyez sur « + » pour créer votre première tâche.</Text>
        </View>
      ) : null}

      {state === 'ready' && tasks.length > 0 ? (
        <FlatList
          data={tasks as Task[]}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <TaskTile task={item} onToggle={handleToggle} />}
          testID="task-list"
        />
      ) : null}

      <Pressable
        style={styles.fab}
        onPress={() => router.push('/add-task')}
        accessibilityRole="button"
        accessibilityLabel="Ajouter une tâche"
        testID="add-task-button"
      >
        <Text style={styles.fabLabel}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#f8fafc', flex: 1 },
  counterBar: {
    backgroundColor: '#ffffff',
    borderBottomColor: '#e2e8f0',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  counter: { color: '#475569', fontSize: 14, fontWeight: '600' },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  hint: { color: '#64748b', fontSize: 14, marginTop: 10, textAlign: 'center' },
  emptyTitle: { color: '#0f172a', fontSize: 18, fontWeight: '700' },
  errorTitle: { color: '#b91c1c', fontSize: 18, fontWeight: '700' },
  retry: { backgroundColor: '#2563eb', borderRadius: 8, marginTop: 16, paddingHorizontal: 20, paddingVertical: 10 },
  retryLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  fab: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 28,
    bottom: 24,
    elevation: 4,
    height: 56,
    justifyContent: 'center',
    position: 'absolute',
    right: 24,
    width: 56,
  },
  fabLabel: { color: '#ffffff', fontSize: 28, fontWeight: '600', lineHeight: 32 },
});
