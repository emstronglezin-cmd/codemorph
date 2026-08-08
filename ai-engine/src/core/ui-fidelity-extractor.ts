// ============================================================
// CodeMorph AI Engine — UI Fidelity Extractor (Phase 4)
//
// Extrait automatiquement les tokens de design depuis les fichiers sources :
//   - Couleurs (hex #RRGGBB, ARGB 0xFFRRGGBB)
//   - Typographie (fontFamily, fontSize, fontWeight)
//   - Espacement (padding, margin, gap, spacing)
//   - Radius (borderRadius, cornerRadius)
//   - Élévations (elevation, shadow)
//   - Thème complet (appBar, buttons, inputs, cards)
//   - Icônes détectées
//   - Animations (duration, curve)
//
// Sortie : IRDesignTokens enrichi + fichiers de thème générés
// ============================================================

import type { GeneratedFile } from '../models/ir.types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ColorToken {
  name:     string;
  value:    string;   // hex canonical: #RRGGBB ou #AARRGGBB
  original: string;   // valeur brute dans la source
  usage?:   string | undefined;  // primary, secondary, background, text, error…
}

export interface TypographyToken {
  name:           string;
  fontFamily?:    string | undefined;
  fontSize?:      number | undefined;
  fontWeight?:    string | number | undefined;
  lineHeight?:    number | undefined;
  letterSpacing?: number | undefined;
}

export interface SpacingToken {
  name:  string;
  value: number;   // px
}

export interface RadiusToken {
  name:  string;
  value: number;   // px
}

export interface ElevationToken {
  name:  string;
  value: number;
}

export interface AnimationToken {
  name:      string;
  duration?: number;   // ms
  curve?:    string;
}

export interface ExtractedDesignSystem {
  colors:      ColorToken[];
  typography:  TypographyToken[];
  spacing:     SpacingToken[];
  radius:      RadiusToken[];
  elevations:  ElevationToken[];
  animations:  AnimationToken[];
  // Thème global déduit
  theme: {
    primaryColor?:    string;
    backgroundColor?: string;
    textPrimary?:     string;
    textSecondary?:   string;
    fontFamily?:      string;
    borderRadius?:    number;
    buttonHeight?:    number;
    useMaterial3?:    boolean;
    appBarElevation?: number;
    cardRadius?:      number;
    inputRadius?:     number;
  };
  // Méta
  sourceFiles: string[];
  extractedAt: string;
}

// ── Normalisation couleurs ────────────────────────────────────────────────────

/**
 * Convertit 0xFFB83A3A → #B83A3A  |  0xB83A3A → #B83A3A  |  #B83A3A → #B83A3A
 * Disponible pour usage externe.
 */
export function normalizeColor(raw: string): string {
  // 0xAARRGGBB (Flutter ARGB)
  const argbMatch = raw.match(/^0x([0-9A-Fa-f]{8})$/);
  if (argbMatch) {
    const hex = argbMatch[1]!;
    return `#${hex.slice(2).toUpperCase()}`;   // drop alpha, keep RGB
  }
  // 0xRRGGBB
  const rgbHexMatch = raw.match(/^0x([0-9A-Fa-f]{6})$/);
  if (rgbHexMatch) return `#${rgbHexMatch[1]!.toUpperCase()}`;

  // #RRGGBB or #RGB
  const hexMatch = raw.match(/^#([0-9A-Fa-f]{3,8})$/);
  if (hexMatch) return `#${hexMatch[1]!.toUpperCase()}`;

  // Color(0xFFRRGGBB) — Flutter inline
  const colorFnMatch = raw.match(/Color\(0x([0-9A-Fa-f]{8})\)/);
  if (colorFnMatch) return `#${colorFnMatch[1]!.slice(2).toUpperCase()}`;

  return raw;
}

/**
 * Détermine l'usage sémantique d'une couleur à partir de son nom
 */
function guessColorUsage(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/primary(?!dark|light|shade)/.test(n)) return 'primary';
  if (/primarydark|darken/.test(n))           return 'primaryDark';
  if (/primarylight|lighten/.test(n))         return 'primaryLight';
  if (/secondary/.test(n))                    return 'secondary';
  if (/background|bg(?!color)/.test(n))       return 'background';
  if (/surface/.test(n))                      return 'surface';
  if (/error/.test(n))                        return 'error';
  if (/success/.test(n))                      return 'success';
  if (/warning/.test(n))                      return 'warning';
  if (/textprimary|text_primary/.test(n))     return 'textPrimary';
  if (/textsecondary|text_secondary/.test(n)) return 'textSecondary';
  if (/text(?!secondary|primary)/.test(n))    return 'text';
  if (/border/.test(n))                       return 'border';
  if (/divider/.test(n))                      return 'divider';
  if (/accent/.test(n))                       return 'accent';
  if (/card/.test(n))                         return 'card';
  return undefined;
}

// ── Extracteur Dart ──────────────────────────────────────────────────────────

/**
 * Extrait les tokens depuis un fichier Dart (AppColors, AppTheme, AppConstants…)
 */
function extractFromDart(content: string, _filePath: string): Partial<ExtractedDesignSystem> {
  const colors:     ColorToken[]     = [];
  const typography: TypographyToken[] = [];
  const spacing:    SpacingToken[]   = [];
  const radius:     RadiusToken[]    = [];
  const elevations: ElevationToken[] = [];
  const animations: AnimationToken[] = [];

  // ── Couleurs: static const Color NAME = Color(0xFFXXXXXX) ───────────────
  const colorPatterns = [
    // static const Color primary = Color(0xFFB83A3A);
    /static\s+const\s+Color\s+(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{8})\)/g,
    // static const primary = Color(0xFFB83A3A);
    /static\s+const\s+(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{8})\)/g,
    // static const Color primary = Color(0xB83A3A);
    /static\s+const\s+Color\s+(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{6})\)/g,
  ];

  for (const pattern of colorPatterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const name = m[1]!;
      const rawHex = m[2]!;
      const normalized = rawHex.length === 8
        ? `#${rawHex.slice(2).toUpperCase()}`
        : `#${rawHex.toUpperCase()}`;
      if (!colors.find((c) => c.name === name)) {
        colors.push({
          name,
          value: normalized,
          original: `0x${rawHex}`,
          usage: guessColorUsage(name),
        });
      }
    }
  }

  // ── Typographie: fontFamily, fontSize ────────────────────────────────────
  const fontFamilyMatch = content.match(/fontFamily:\s*['"]([^'"]+)['"]/);
  if (fontFamilyMatch) {
    typography.push({
      name: 'default',
      fontFamily: fontFamilyMatch[1],
    });
  }

  // TextStyle avec size
  const textStylePattern = /(\w+):\s*TextStyle\([^)]*fontSize:\s*(\d+(?:\.\d+)?)[^)]*\)/g;
  let tsm: RegExpExecArray | null;
  while ((tsm = textStylePattern.exec(content)) !== null) {
    typography.push({
      name: tsm[1]!,
      fontSize: parseFloat(tsm[2]!),
    });
  }

  // ── Spacing / padding constants ──────────────────────────────────────────
  const spacingPattern = /static\s+const\s+double\s+(\w+(?:padding|spacing|gap|margin|size)\w*)\s*=\s*(\d+(?:\.\d+)?)/gi;
  let spm: RegExpExecArray | null;
  while ((spm = spacingPattern.exec(content)) !== null) {
    spacing.push({ name: spm[1]!, value: parseFloat(spm[2]!) });
  }

  // ── Border radius ────────────────────────────────────────────────────────
  const radiusPattern = /(?:borderRadius|radius|cornerRadius)\w*\s*[=:]\s*(?:BorderRadius\.circular\(|Radius\.circular\(|)?(\d+(?:\.\d+)?)/g;
  let rm: RegExpExecArray | null;
  let rIdx = 0;
  while ((rm = radiusPattern.exec(content)) !== null) {
    const val = parseFloat(rm[1]!);
    if (val > 0 && val < 100) {
      radius.push({ name: `radius_${rIdx++}`, value: val });
    }
  }

  // ── Elevation ────────────────────────────────────────────────────────────
  const elevationPattern = /elevation:\s*(\d+(?:\.\d+)?)/g;
  let em: RegExpExecArray | null;
  let eIdx = 0;
  while ((em = elevationPattern.exec(content)) !== null) {
    elevations.push({ name: `elevation_${eIdx++}`, value: parseFloat(em[1]!) });
  }

  // ── Animations ───────────────────────────────────────────────────────────
  const durationPattern = /Duration\((?:milliseconds:\s*(\d+)|seconds:\s*(\d+))\)/g;
  let dm: RegExpExecArray | null;
  let dIdx = 0;
  while ((dm = durationPattern.exec(content)) !== null) {
    const ms = dm[1] ? parseInt(dm[1]) : (dm[2] ? parseInt(dm[2]) * 1000 : 300);
    animations.push({ name: `anim_${dIdx++}`, duration: ms });
  }

  const curvePattern = /Curves\.(\w+)/g;
  let cm: RegExpExecArray | null;
  let cIdx = 0;
  while ((cm = curvePattern.exec(content)) !== null) {
    if (cIdx < animations.length) {
      animations[cIdx]!.curve = `Curves.${cm[1]}`;
    } else {
      animations.push({ name: `curve_${cIdx}`, curve: `Curves.${cm[1]}` });
    }
    cIdx++;
  }

  // ── Thème global déduit ──────────────────────────────────────────────────
  const theme: ExtractedDesignSystem['theme'] = {};

  const primaryColor = colors.find((c) => c.usage === 'primary');
  if (primaryColor) theme.primaryColor = primaryColor.value;

  const bgColor = colors.find((c) => c.usage === 'background');
  if (bgColor) theme.backgroundColor = bgColor.value;

  const textColor = colors.find((c) => c.usage === 'textPrimary' || c.usage === 'text');
  if (textColor) theme.textPrimary = textColor.value;

  const textSecColor = colors.find((c) => c.usage === 'textSecondary');
  if (textSecColor) theme.textSecondary = textSecColor.value;

  const fontFamilyTok = typography.find((t) => t.fontFamily);
  if (fontFamilyTok?.fontFamily) theme.fontFamily = fontFamilyTok.fontFamily;

  // Radius le plus fréquent → borderRadius global
  if (radius.length > 0) {
    const freq = new Map<number, number>();
    radius.forEach((r) => freq.set(r.value, (freq.get(r.value) ?? 0) + 1));
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const topRadius = sorted[0]?.[0];
    if (topRadius !== undefined) theme.borderRadius = topRadius;
  }

  // Button height
  const heightMatch = content.match(/(?:height|minHeight):\s*(\d+(?:\.\d+)?)/);
  if (heightMatch) theme.buttonHeight = parseFloat(heightMatch[1]!);

  // Material 3
  theme.useMaterial3 = content.includes('useMaterial3: true');

  // AppBar elevation
  const appBarElMatch = content.match(/AppBar[^{]*{[^}]*elevation:\s*(\d+)/);
  if (appBarElMatch) theme.appBarElevation = parseFloat(appBarElMatch[1]!);

  return { colors, typography, spacing, radius, elevations, animations, theme };
}

// ── Extracteur TypeScript/TSX ─────────────────────────────────────────────────

function extractFromTS(content: string, _filePath: string): Partial<ExtractedDesignSystem> {
  const colors:     ColorToken[]     = [];
  const typography: TypographyToken[] = [];
  const spacing:    SpacingToken[]   = [];
  const radius:     RadiusToken[]    = [];

  // colors: { primary: '#B83A3A', ... }
  const colorTSPattern = /(\w+):\s*['"]#([0-9A-Fa-f]{3,8})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = colorTSPattern.exec(content)) !== null) {
    colors.push({
      name: m[1]!,
      value: `#${m[2]!.toUpperCase()}`,
      original: `#${m[2]}`,
      usage: guessColorUsage(m[1]!),
    });
  }

  // fontSize
  const fontSizePattern = /fontSize:\s*(\d+)/g;
  let fsm: RegExpExecArray | null;
  let fsIdx = 0;
  while ((fsm = fontSizePattern.exec(content)) !== null) {
    typography.push({ name: `text_${fsIdx++}`, fontSize: parseInt(fsm[1]!) });
  }

  // borderRadius
  const brPattern = /borderRadius:\s*(\d+)/g;
  let brm: RegExpExecArray | null;
  let brIdx = 0;
  while ((brm = brPattern.exec(content)) !== null) {
    radius.push({ name: `radius_${brIdx++}`, value: parseInt(brm[1]!) });
  }

  // spacing/padding
  const paddingPattern = /(?:padding|margin|gap|spacing):\s*(\d+)/gi;
  let pm: RegExpExecArray | null;
  let pmIdx = 0;
  while ((pm = paddingPattern.exec(content)) !== null) {
    spacing.push({ name: `space_${pmIdx++}`, value: parseInt(pm[1]!) });
  }

  return { colors, typography, spacing, radius };
}

// ── Fonction principale ───────────────────────────────────────────────────────

/**
 * Extrait le design system complet depuis un ensemble de fichiers sources.
 *
 * @param sourceFiles  Fichiers du projet source (Dart, TS, TSX…)
 * @returns ExtractedDesignSystem complet, prêt à injecter dans IRDesignTokens
 */
export function extractDesignSystem(sourceFiles: { path: string; content: string }[]): ExtractedDesignSystem {
  const allColors:     ColorToken[]     = [];
  const allTypography: TypographyToken[] = [];
  const allSpacing:    SpacingToken[]   = [];
  const allRadius:     RadiusToken[]    = [];
  const allElevations: ElevationToken[] = [];
  const allAnimations: AnimationToken[] = [];
  let   mergedTheme:   ExtractedDesignSystem['theme'] = {};
  const processedFiles: string[] = [];

  // Prioriser les fichiers de design (app_colors, theme, constants)
  const designFiles = sourceFiles.filter((f) =>
    /(?:color|theme|style|constant|token|spacing|typography)/i.test(f.path)
  );
  const otherFiles = sourceFiles.filter((f) =>
    !/(?:color|theme|style|constant|token|spacing|typography)/i.test(f.path)
  );

  // Traiter design files en premier
  const filesToProcess = [...designFiles, ...otherFiles].slice(0, 30); // max 30 fichiers

  for (const file of filesToProcess) {
    const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
    let extracted: Partial<ExtractedDesignSystem> = {};

    if (ext === 'dart') {
      extracted = extractFromDart(file.content, file.path);
    } else if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
      extracted = extractFromTS(file.content, file.path);
    } else {
      continue;
    }

    processedFiles.push(file.path);

    // Merge couleurs (dédupliqué)
    for (const c of extracted.colors ?? []) {
      if (!allColors.find((ac) => ac.name === c.name)) {
        allColors.push(c);
      }
    }

    // Merge typographie (dédupliqué)
    for (const t of extracted.typography ?? []) {
      if (!allTypography.find((at) => at.fontFamily && at.fontFamily === t.fontFamily)) {
        allTypography.push(t);
      }
    }

    // Merge spacing (dédupliqué)
    for (const s of extracted.spacing ?? []) {
      if (!allSpacing.find((as) => as.value === s.value)) {
        allSpacing.push(s);
      }
    }

    // Merge radius (dédupliqué)
    for (const r of extracted.radius ?? []) {
      if (!allRadius.find((ar) => ar.value === r.value)) {
        allRadius.push(r);
      }
    }

    allElevations.push(...(extracted.elevations ?? []));
    allAnimations.push(...(extracted.animations ?? []));

    // Merge thème (priorité aux fichiers de design)
    if (extracted.theme) {
      mergedTheme = { ...extracted.theme, ...mergedTheme };
    }
  }

  // Trier spacing par valeur
  allSpacing.sort((a, b) => a.value - b.value);
  allRadius.sort((a, b) => a.value - b.value);

  return {
    colors:     allColors,
    typography: allTypography,
    spacing:    allSpacing,
    radius:     allRadius,
    elevations: allElevations,
    animations: allAnimations,
    theme:      mergedTheme,
    sourceFiles: processedFiles,
    extractedAt: new Date().toISOString(),
  };
}

// ── Générateurs de fichiers de thème ──────────────────────────────────────────

/**
 * Génère un fichier app_colors.dart à partir du design system extrait.
 * Utilisé quand la cible est Flutter.
 */
export function generateFlutterColorsFile(ds: ExtractedDesignSystem): string {
  if (ds.colors.length === 0) return '';

  const colorLines = ds.colors
    .map((c) => {
      const argb = c.value.startsWith('#')
        ? `0xFF${c.value.slice(1).padStart(6, '0')}`
        : c.original;
      return `  static const Color ${c.name} = Color(${argb});`;
    })
    .join('\n');

  return `import 'package:flutter/material.dart';

// ============================================================
// AppColors — Extrait automatiquement par CodeMorph
// Source: ${ds.sourceFiles.slice(0, 2).join(', ')}
// ============================================================

class AppColors {
${colorLines}
}
`;
}

/**
 * Génère un fichier colors.ts à partir du design system extrait.
 * Utilisé quand la cible est React Native / React.
 */
export function generateRNColorsFile(ds: ExtractedDesignSystem): string {
  if (ds.colors.length === 0) return '';

  const colorLines = ds.colors
    .map((c) => `  ${c.name}: '${c.value}',`)
    .join('\n');

  return `// ============================================================
// AppColors — Extrait automatiquement par CodeMorph
// Source: ${ds.sourceFiles.slice(0, 2).join(', ')}
// ============================================================

export const AppColors = {
${colorLines}
} as const;

export type AppColor = keyof typeof AppColors;
`;
}

/**
 * Génère un fichier app_theme.dart à partir du design system extrait.
 */
export function generateFlutterThemeFile(ds: ExtractedDesignSystem): string {
  const { theme, colors } = ds;
  const primaryHex = theme.primaryColor ?? colors.find((c) => c.usage === 'primary')?.value ?? '#2196F3';
  const bgHex = theme.backgroundColor ?? '#FFFFFF';
  const fontFamily = theme.fontFamily ?? 'Roboto';
  const cardRadius = theme.cardRadius ?? theme.borderRadius ?? 16;
  const inputRadius = theme.inputRadius ?? theme.borderRadius ?? 12;
  const buttonHeight = theme.buttonHeight ?? 52;
  const useMaterial3 = theme.useMaterial3 ?? true;

  const toArgb = (hex: string): string =>
    hex.startsWith('#') ? `0xFF${hex.slice(1).padStart(6, '0')}` : hex;

  return `import 'package:flutter/material.dart';
import 'app_colors.dart';

// ============================================================
// AppTheme — Extrait automatiquement par CodeMorph (Phase 4)
// ============================================================

class AppTheme {
  AppTheme._();

  static ThemeData get light => ThemeData(
    useMaterial3: ${useMaterial3},
    colorScheme: ColorScheme.fromSeed(
      seedColor: const Color(${toArgb(primaryHex)}),
      background: const Color(${toArgb(bgHex)}),
    ),
    fontFamily: '${fontFamily}',
    appBarTheme: const AppBarTheme(
      elevation: ${theme.appBarElevation ?? 0},
      centerTitle: true,
    ),
    cardTheme: CardTheme(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(${cardRadius}),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(${inputRadius}),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        minimumSize: const Size(double.infinity, ${buttonHeight}),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(${inputRadius + 2}),
        ),
      ),
    ),
  );
}
`;
}

/**
 * Génère les fichiers de thème complets (colors + theme) sous forme de GeneratedFile[].
 */
export function generateThemeFiles(
  ds: ExtractedDesignSystem,
  targetFramework: string,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const isFlutter = /flutter/i.test(targetFramework);
  const isRN = /react.?native|rn/i.test(targetFramework);

  if (isFlutter) {
    const colorsContent = generateFlutterColorsFile(ds);
    if (colorsContent) {
      files.push({
        path:     'lib/core/constants/app_colors.dart',
        content:  colorsContent,
        language: 'dart',
      });
    }

    const themeContent = generateFlutterThemeFile(ds);
    if (themeContent) {
      files.push({
        path:     'lib/core/theme/app_theme.dart',
        content:  themeContent,
        language: 'dart',
      });
    }
  } else if (isRN) {
    const colorsContent = generateRNColorsFile(ds);
    if (colorsContent) {
      files.push({
        path:     'src/theme/colors.ts',
        content:  colorsContent,
        language: 'typescript',
      });
    }

    // Spacing tokens
    if (ds.spacing.length > 0) {
      const spacingLines = ds.spacing
        .slice(0, 20)
        .map((s) => `  ${s.name}: ${s.value},`)
        .join('\n');
      files.push({
        path:     'src/theme/spacing.ts',
        content:  `export const Spacing = {\n${spacingLines}\n} as const;\n`,
        language: 'typescript',
      });
    }

    // Typography tokens
    if (ds.typography.length > 0) {
      const fontFamily = ds.theme.fontFamily ?? 'System';
      files.push({
        path:     'src/theme/typography.ts',
        content: `import { StyleSheet } from 'react-native';\n\nexport const FontFamily = '${fontFamily}';\n\nexport const Typography = StyleSheet.create({\n  body: { fontFamily: FontFamily, fontSize: 14 },\n  title: { fontFamily: FontFamily, fontSize: 20, fontWeight: '700' },\n  caption: { fontFamily: FontFamily, fontSize: 12 },\n});\n`,
        language: 'typescript',
      });
    }
  }

  return files;
}
