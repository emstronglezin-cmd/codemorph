import React, { useState } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { taskService } from '../src/services/taskservice.service';

/**
 * Écran d'ajout — conversion de `lib/screens/add_task_screen.dart`.
 *
 * Retour du formulaire SANS paramètre de route fonctionnel : la source faisait
 * `Navigator.pop(context, text)`, ce qu'Expo Router ne permet pas. La tâche est
 * créée ici sur le service partagé, puis on revient en arrière ; l'écran
 * d'accueil, abonné au service, l'affiche immédiatement.
 */
export default function AddTaskScreen(): React.JSX.Element {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (): void => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setError('Le titre ne peut pas être vide');
      return;
    }
    taskService.add(trimmed);
    setError(null);
    router.back();
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: 'Nouvelle tâche' }} />

      <View style={styles.body}>
        <Text style={styles.label}>Titre</Text>
        <TextInput
          style={[styles.input, error ? styles.inputError : null]}
          value={title}
          onChangeText={(text) => {
            setTitle(text);
            if (error) setError(null);
          }}
          placeholder="Que faut-il faire ?"
          placeholderTextColor="#94a3b8"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
          testID="task-title-input"
        />

        {error ? <Text style={styles.error} testID="form-error">{error}</Text> : null}

        <Pressable
          style={[styles.submit, title.trim().length === 0 && styles.submitDisabled]}
          onPress={handleSubmit}
          accessibilityRole="button"
          accessibilityLabel="Ajouter la tâche"
          testID="submit-task-button"
        >
          <Text style={styles.submitLabel}>Ajouter</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#f8fafc', flex: 1 },
  body: { padding: 16 },
  label: { color: '#334155', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  input: {
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
    borderRadius: 8,
    borderWidth: 1,
    color: '#0f172a',
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  inputError: { borderColor: '#dc2626' },
  error: { color: '#dc2626', fontSize: 13, marginTop: 8 },
  submit: { alignItems: 'center', backgroundColor: '#2563eb', borderRadius: 8, marginTop: 20, paddingVertical: 14 },
  submitDisabled: { backgroundColor: '#93c5fd' },
  submitLabel: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
});
