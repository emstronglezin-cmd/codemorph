import React from 'react';
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet, type TouchableOpacityProps } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme';

interface ButtonProps extends TouchableOpacityProps {
  title: string;
  variant?: 'primary' | 'secondary' | 'outline';
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function Button({ title, variant = 'primary', loading = false, size = 'md', disabled, ...props }: ButtonProps): React.JSX.Element {
  return (
    <TouchableOpacity
      {...props}
      disabled={disabled || loading}
      style={[s.base, s[variant], s[`size_${size}`], (disabled || loading) && s.disabled]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'outline' ? colors.primary : colors.white} size="small" />
      ) : (
        <Text style={[s.text, variant === 'outline' && s.textOutline]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  base:       { borderRadius: borderRadius.md, alignItems: 'center', justifyContent: 'center' },
  primary:    { backgroundColor: colors.primary },
  secondary:  { backgroundColor: colors.secondary },
  outline:    { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary },
  size_sm:    { paddingVertical: spacing.xs,  paddingHorizontal: spacing.sm },
  size_md:    { paddingVertical: spacing.sm,  paddingHorizontal: spacing.md },
  size_lg:    { paddingVertical: spacing.md,  paddingHorizontal: spacing.lg },
  disabled:   { opacity: 0.5 },
  text:       { color: colors.white,   fontWeight: '600' },
  textOutline:{ color: colors.primary, fontWeight: '600' },
});
