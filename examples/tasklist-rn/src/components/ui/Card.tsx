import React from 'react';
import { View, StyleSheet, type ViewProps } from 'react-native';
import { colors, spacing, borderRadius } from '../../theme/index';

export function Card({ children, style, ...props }: ViewProps): React.JSX.Element {
  return (
    <View {...props} style={[s.card, style]}>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius:    borderRadius.lg,
    padding:         spacing.md,
    borderWidth:     1,
    borderColor:     colors.border,
  },
});
