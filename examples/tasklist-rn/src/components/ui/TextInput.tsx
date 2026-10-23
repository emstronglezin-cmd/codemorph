import React from 'react';
import { TextInput as RNTextInput, View, Text, StyleSheet, type TextInputProps } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

export function TextInput({ label, error, style, ...props }: InputProps): React.JSX.Element {
  return (
    <View style={s.container}>
      {label ? <Text style={s.label}>{label}</Text> : null}
      <RNTextInput
        {...props}
        style={[s.input, error ? s.inputError : null, style]}
        placeholderTextColor={colors.textMuted}
      />
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: { marginBottom: spacing.sm },
  label:     { color: colors.text, fontWeight: '500', marginBottom: spacing.xs },
  input:     { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: borderRadius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.text },
  inputError:{ borderColor: colors.error },
  error:     { color: colors.error, fontSize: 12, marginTop: spacing.xs },
});
