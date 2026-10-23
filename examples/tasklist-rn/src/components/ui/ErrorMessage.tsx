import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme/index';

export function ErrorMessage({ message }: { message: string }): React.JSX.Element {
  return (
    <View style={s.container}>
      <Text style={s.text}>⚠️ {message}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { backgroundColor: colors.error + '20', borderRadius: borderRadius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.error },
  text:      { color: colors.error, fontWeight: '500' },
});
