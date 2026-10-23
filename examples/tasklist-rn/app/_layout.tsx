import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/**
 * Layout racine Expo Router.
 * Routes déclarées == fichiers présents :
 *   index    → app/index.tsx     (écran d'accueil, ouvert au démarrage)
 *   add-task → app/add-task.tsx  (formulaire d'ajout)
 */
export default function RootLayout(): React.JSX.Element {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#ffffff' },
          headerTitleStyle: { color: '#0f172a', fontWeight: '700' },
          headerTintColor: '#2563eb',
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Mes tâches' }} />
        <Stack.Screen name="add-task" options={{ title: 'Nouvelle tâche', presentation: 'modal' }} />
      </Stack>
    </>
  );
}
