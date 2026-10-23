import React from 'react';
import {
  Pressable, StyleSheet, Text, View,
} from 'react-native';

import type { Task } from '../types/task.types';

export interface TaskTileProps {
  task: Task;
  /** Reçoit l'identifiant — jamais de fonction passée par la navigation. */
  onToggle: (id: string) => void;
}

/**
 * `TaskTile` — conversion de `lib/widgets/task_tile.dart`.
 * Consomme le modèle `Task` partagé : mêmes propriétés, mêmes types que le
 * service et les écrans.
 */
export function TaskTile({ task, onToggle }: TaskTileProps): React.JSX.Element {
  return (
    <View style={styles.row} testID={`task-tile-${task.id}`}>
      <Pressable
        onPress={() => onToggle(task.id)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: task.isDone }}
        accessibilityLabel={`Marquer « ${task.title} » comme ${task.isDone ? 'non terminée' : 'terminée'}`}
        hitSlop={8}
        style={styles.checkbox}
        testID={`task-toggle-${task.id}`}
      >
        <View style={[styles.box, task.isDone && styles.boxChecked]}>
          {task.isDone ? <Text style={styles.check}>✓</Text> : null}
        </View>
      </Pressable>

      <Text
        style={[styles.title, task.isDone && styles.titleDone]}
        numberOfLines={2}
        testID={`task-title-${task.id}`}
      >
        {task.title}
      </Text>
    </View>
  );
}

const BOX = 24;

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomColor: '#e2e8f0',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  checkbox: { padding: 2 },
  box: {
    alignItems: 'center',
    borderColor: '#94a3b8',
    borderRadius: 6,
    borderWidth: 2,
    height: BOX,
    justifyContent: 'center',
    width: BOX,
  },
  boxChecked: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  check: { color: '#ffffff', fontSize: 14, fontWeight: '700', lineHeight: 16 },
  title: { color: '#0f172a', flex: 1, fontSize: 16 },
  titleDone: { color: '#94a3b8', textDecorationLine: 'line-through' },
});

export default TaskTile;
