import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { colors } from '../../theme/index';

export function LoadingSpinner({ size = 'large' }: { size?: 'small' | 'large' }): React.JSX.Element {
  return (
    <View style={s.container}>
      <ActivityIndicator size={size} color={colors.primary} />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
