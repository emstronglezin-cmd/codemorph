// src/theme/typography.ts — jetons typographiques
import { TextStyle } from 'react-native';

export const fontSizes = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 21,
  xxl: 27,
  display: 34,
} as const;

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const lineHeights = {
  tight: 16,
  normal: 22,
  relaxed: 28,
  loose: 34,
} as const;

export const typography = {
  display: { fontSize: fontSizes.display, fontWeight: fontWeights.bold, lineHeight: lineHeights.loose } as TextStyle,
  title:   { fontSize: fontSizes.xl,      fontWeight: fontWeights.semibold, lineHeight: lineHeights.relaxed } as TextStyle,
  heading: { fontSize: fontSizes.lg,      fontWeight: fontWeights.semibold, lineHeight: lineHeights.normal } as TextStyle,
  body:    { fontSize: fontSizes.md,      fontWeight: fontWeights.regular, lineHeight: lineHeights.normal } as TextStyle,
  caption: { fontSize: fontSizes.sm,      fontWeight: fontWeights.regular, lineHeight: lineHeights.tight } as TextStyle,
  label:   { fontSize: fontSizes.xs,      fontWeight: fontWeights.medium, lineHeight: lineHeights.tight } as TextStyle,
} as const;

export type TypographyVariant = keyof typeof typography;
