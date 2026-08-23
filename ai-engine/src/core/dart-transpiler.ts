// ============================================================
// CodeMorph AI Engine — Dart→TypeScript Deterministic Transpiler
//
// Convertit le code Dart en TypeScript par transformation de patterns.
// Utilisé comme fallback quand aucun provider LLM n'est disponible.
// Produit du vrai code TypeScript fonctionnel (pas des stubs).
//
// COUVERTURE:
//   - Imports (package: → relative, dart: → built-in TS)
//   - Types (String→string, int/double/num→number, bool→boolean, List<T>→T[],
//            Map<K,V>→Record<K,V>, Future<T>→Promise<T>, void→void)
//   - Classes (class, abstract class, extends, implements)
//   - Méthodes async/await
//   - Getters/setters
//   - Data classes (fromJson/toJson/copyWith)
//   - Null safety (? → ?)
//   - Constructeurs → TypeScript constructors
//   - Enum
//   - Extension → standalone functions
// ============================================================

export interface TranspileResult {
  content:   string;
  warnings:  string[];
  lines:     number;
  coverage:  number; // % lignes source transformées (0-100)
}

// ── Type mappings Dart → TypeScript ──────────────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  'String':    'string',
  'int':       'number',
  'double':    'number',
  'num':       'number',
  'bool':      'boolean',
  'dynamic':   'unknown',
  'Object':    'unknown',
  'void':      'void',
  'Never':     'never',
  'Null':      'null',
  'DateTime':  'Date',
  'Duration':  'number', // milliseconds
  'Uri':       'string',
  'Uint8List': 'Uint8Array',
  'List':      'Array',
  'Set':       'Set',
  'Map':       'Record',
  'Future':    'Promise',
  'Stream':    'AsyncIterable',
  'Iterable':  'Iterable',
};

const IMPORT_MAP: Record<string, string | null> = {
  "package:flutter/material.dart":         "// flutter/material → react-native (View, Text, StyleSheet)",
  "package:flutter/widgets.dart":          "// flutter/widgets → react-native",
  "package:flutter/services.dart":         "// flutter/services → react-native Platform",
  "package:flutter_riverpod/flutter_riverpod.dart": "import { create } from 'zustand'; // Riverpod → Zustand",
  "package:riverpod_annotation/riverpod_annotation.dart": "import { create } from 'zustand'; // Riverpod annotations → Zustand",
  "package:dio/dio.dart":                  "import axios from 'axios'; // dio → axios",
  "package:shared_preferences/shared_preferences.dart": "import AsyncStorage from '@react-native-async-storage/async-storage'; // SharedPreferences → AsyncStorage",
  "package:get_it/get_it.dart":            "// get_it → DI not needed in React (use hooks/context)",
  "package:injectable/injectable.dart":    "// injectable → DI not needed in React",
  "package:json_annotation/json_annotation.dart": "// json_annotation → TypeScript handles this natively",
  "package:freezed_annotation/freezed_annotation.dart": "// freezed → TypeScript interfaces",
  "package:equatable/equatable.dart":      "// equatable → TypeScript equality",
  "package:flutter/foundation.dart":       "// flutter/foundation → N/A in RN",
  "package:auto_route/auto_route.dart":    "import { useRouter } from 'expo-router'; // auto_route → expo-router",
  "package:go_router/go_router.dart":      "import { useRouter } from 'expo-router'; // go_router → expo-router",
  "dart:async":                            "// dart:async → built-in Promise/async-await",
  "dart:convert":                          "// dart:convert → JSON.parse/JSON.stringify",
  "dart:io":                               "// dart:io → React Native Platform API",
  "dart:math":                             "// dart:math → Math",
  "dart:collection":                       "// dart:collection → built-in Map/Set",
  "dart:typed_data":                       "// dart:typed_data → TypedArrays",
};

// ── Transformations ligne par ligne ──────────────────────────────────────────

function transpileLine(line: string, ctx: TranspileContext): string {
  let l = line;

  // Commentaires → garder tels quels
  if (l.trimStart().startsWith('//') || l.trimStart().startsWith('*') || l.trimStart().startsWith('/*')) {
    return l;
  }

  // Annotations Dart → commentaires TS
  l = l.replace(/^\s*@\w+(?:\(.*?\))?\s*$/, (m) => `  // ${m.trim()}`);
  l = l.replace(/@override\s*/g, '');
  l = l.replace(/@required\s*/g, '');
  l = l.replace(/@immutable\s*/g, '');

  // Import statements
  if (l.trimStart().startsWith("import '") || l.trimStart().startsWith('import "')) {
    return transpileImport(l);
  }
  if (l.trimStart().startsWith("part '") || l.trimStart().startsWith("part of")) {
    return `// ${l.trim()} (Dart part files → not needed in TS)`;
  }

  // Types dans les signatures
  l = transpileTypes(l);

  // async* / yield* → generators (pas parfait mais compila)
  l = l.replace(/\basync\*/g, 'async');
  l = l.replace(/\byield\*/g, 'yield');
  l = l.replace(/\byield\b/g, 'yield');

  // final → const/readonly
  l = l.replace(/\bfinal\b\s+(?=[\w<])/g, 'const ');
  l = l.replace(/\bconst\b\s+/g, 'const '); // dédupliquer

  // late → let
  l = l.replace(/\blate\s+/g, '');

  // var → let
  l = l.replace(/\bvar\b\s+/g, 'let ');

  // required en paramètre
  l = l.replace(/\brequired\s+this\./g, 'this.');
  l = l.replace(/\brequired\s+/g, '');

  // this.field en constructeur → handled by constructor body
  l = l.replace(/\bthis\.(\w+)\s*(?=[,)\n])/g, 'this.$1');

  // print() → console.log()
  l = l.replace(/\bprint\s*\(/g, 'console.log(');

  // debugPrint → console.debug
  l = l.replace(/\bdebugPrint\s*\(/g, 'console.debug(');

  // throw Exception → throw new Error
  l = l.replace(/\bthrow\s+(\w+Exception|Exception)\s*\(/g, 'throw new Error(');

  // rethrow → throw err (approximation)
  l = l.replace(/\brethrow\s*;/g, 'throw err;');

  // Dart string interpolation $var → ${var} (mostly already correct)
  // '$name' → `${name}` 
  l = convertStringInterpolation(l);

  // ?? (null coalescing) → ?? (same in TS)
  // ?. (optional chaining) → ?. (same in TS)
  // These are already valid TS

  // Arrow functions: => already valid in TS

  // ── Flutter/Riverpod class patterns → React/TS equivalents ─────────────────
  // ConsumerStatefulWidget / ConsumerWidget / StatefulWidget → commented
  l = l.replace(/\bextends\s+ConsumerStatefulWidget\b/g, '/* extends ConsumerStatefulWidget → React FC */');
  l = l.replace(/\bextends\s+ConsumerWidget\b/g, '/* extends ConsumerWidget → React FC */');
  l = l.replace(/\bextends\s+ConsumerState<[^>]+>/g, '/* extends ConsumerState → React FC state */');
  l = l.replace(/\bextends\s+StatefulWidget\b/g, '/* extends StatefulWidget → React FC */');
  l = l.replace(/\bextends\s+StatelessWidget\b/g, '/* extends StatelessWidget → React FC */');
  l = l.replace(/\bextends\s+State<[^>]+>/g, '/* extends State → React FC state */');
  l = l.replace(/\bConsumerState<[^>]+>/g, 'React.FC');
  // Widget build(BuildContext context) → render(): JSX.Element
  l = l.replace(/\bWidget\s+build\s*\(\s*BuildContext\s+context[^)]*\)/g, 'render(): React.JSX.Element');
  // BuildContext → unknown
  l = l.replace(/\bBuildContext\b/g, 'unknown /* BuildContext */');
  // GlobalKey<FormState>() → useRef
  l = l.replace(/\bGlobalKey<FormState>\s*\(\)/g, 'useRef(null) /* FormKey */');
  l = l.replace(/\bGlobalKey<[^>]+>\s*\(\)/g, 'useRef(null)');
  // TextEditingController → ref text
  l = l.replace(/\bnew\s+TextEditingController\s*\(\)/g, "{ text: '' }");
  l = l.replace(/\bTextEditingController\s*\(\)/g, "{ text: '' }");
  l = l.replace(/\bTextEditingController\b/g, '{ text: string }');
  // FocusNode → ref
  l = l.replace(/\bFocusNode\s*\(\)/g, 'useRef(null)');
  l = l.replace(/\bFocusNode\b/g, 'unknown /* FocusNode */');
  // super.key pattern
  l = l.replace(/\{super\.key\}/g, '');
  l = l.replace(/super\.key[,;\s]/g, '');
  // ref.read / ref.watch (Riverpod) → zustand hook
  l = l.replace(/\bref\.read\s*\(/g, 'useStore(');
  l = l.replace(/\bref\.watch\s*\(/g, 'useStore(');
  l = l.replace(/\.notifier\b/g, '');
  // ScaffoldMessenger → Alert
  l = l.replace(/ScaffoldMessenger\.of\s*\([^)]*\)\.showSnackBar\s*\(/g, 'alert(');
  // Navigator → useRouter
  l = l.replace(/Navigator\.of\s*\([^)]*\)\.push(?:Named|Replacement|AndRemoveUntil)?\s*\(/g, 'router.push(');
  l = l.replace(/Navigator\.of\s*\([^)]*\)\.pop\s*\(\)/g, 'router.back()');
  l = l.replace(/Navigator\.pop\s*\([^)]*\)/g, 'router.back()');

  // abstract class → abstract class (same)
  // extends → extends (same)
  // implements → implements (same)
  // with → // implements (mixin approximation)
  l = l.replace(/\bwith\s+([\w,\s]+)(?=\s*\{)/g, (_, mixins) => {
    ctx.warnings.push(`Mixin 'with ${mixins.trim()}' requires manual implementation`);
    return `/* implements ${mixins.trim()} */`;
  });

  // factory constructor → static create()
  l = l.replace(/^\s*factory\s+\w+\.(\w+)\s*\(/, (_, name) =>
    `  static ${name}(`
  );
  l = l.replace(/^\s*factory\s+(\w+)\s*\(/, `  static create(`);

  // Named constructor: ClassName.name() → static name()
  // (handled partially by factory above)

  // Dart getter: Type get name => expr; → get name(): Type { return expr; }
  l = l.replace(/^\s*(\w[\w<>?]*)\s+get\s+(\w+)\s*=>\s*(.+?);/, (_, type, name, expr) =>
    `  get ${name}(): ${mapType(type)} { return ${expr}; }`
  );
  l = l.replace(/^\s*(\w[\w<>?]*)\s+get\s+(\w+)\s*\{/, (_, type, name) =>
    `  get ${name}(): ${mapType(type)} {`
  );

  // Dart setter: set name(Type value) { → set name(value: Type) {
  l = l.replace(/\bset\s+(\w+)\s*\((\w[\w<>?]*)\s+(\w+)\)/, (_, name, type, param) =>
    `set ${name}(${param}: ${mapType(type)})`
  );

  // copyWith pattern
  if (l.includes('copyWith')) {
    ctx.hasCopyWith = true;
  }

  // fromJson / fromMap
  l = l.replace(/factory\s+(\w+)\.fromJson\(Map<String,\s*dynamic>\s+(\w+)\)/, (_, cls, param) =>
    `static fromJson(${param}: Record<string, unknown>): ${cls}`
  );
  l = l.replace(/factory\s+(\w+)\.fromMap\(Map<String,\s*dynamic>\s+(\w+)\)/, (_, cls, param) =>
    `static fromJson(${param}: Record<string, unknown>): ${cls}`
  );

  // toJson / toMap → toJson(): Record<string, unknown>
  l = l.replace(/Map<String,\s*dynamic>\s+toJson\(\)/, `toJson(): Record<string, unknown>`);
  l = l.replace(/Map<String,\s*dynamic>\s+toMap\(\)/, `toJson(): Record<string, unknown>`);

  // .cast<T>() → as T[] (approximation)
  l = l.replace(/\.cast<(\w+)>\(\)/g, ' as $1[]');

  // as Type → as Type (same in TS)

  // Dart List literals: <Type>[] → [] or Type[]
  l = l.replace(/<(\w+)>\[\]/g, '[]');

  // if (x is Type) → if (x instanceof Type) — partiel
  l = l.replace(/\bis\s+(\w+)/g, 'instanceof $1');

  // Trailing commas in function calls (valid in both)

  // Semicolons are already required in Dart, same in TS

  // Remove Dart's 'const' keyword in expressions (not declarations)
  l = l.replace(/\bconst\s+(?=[A-Z])/g, ''); // const MyWidget(...) → MyWidget(...)

  void ctx;
  return l;
}

interface TranspileContext {
  warnings:    string[];
  hasCopyWith: boolean;
  className:   string;
}

function transpileImport(line: string): string {
  const match = /import\s+['"](.+?)['"]\s*(?:as\s+\w+)?\s*;/.exec(line);
  if (!match?.[1]) return `// ${line.trim()}`;
  
  const pkg = match[1];
  
  // Lookup exact match
  if (pkg in IMPORT_MAP) {
    const mapped = IMPORT_MAP[pkg];
    return mapped === null ? '' : (mapped ?? `// ${pkg}`);
  }
  
  // Package imports → relative
  if (pkg.startsWith('package:')) {
    const parts = pkg.replace('package:', '').split('/');
    const fileName = (parts[parts.length - 1] ?? '').replace('.dart', '');
    return `import { ${toCamelCase(fileName)} } from './${fileName}'; // TODO: verify import`;
  }
  
  // Relative imports
  if (pkg.startsWith('../') || pkg.startsWith('./')) {
    const tsPath = pkg.replace('.dart', '');
    return `import * as ${toCamelCase(pkg.split('/').pop()?.replace('.dart','') ?? 'mod')} from '${tsPath}';`;
  }
  
  return `// import '${pkg}' (unmapped — TODO: replace manually)`;
}

function transpileTypes(line: string): string {
  // Replace Dart types with TypeScript equivalents
  // List<T> → T[]
  line = line.replace(/\bList<([^>]+)>\??\b/g, (_, t) => `${mapType(t)}[]`);
  // Map<K, V> → Record<K, V>
  line = line.replace(/\bMap<([^,>]+),\s*([^>]+)>\??\b/g, (_, k, v) =>
    `Record<${mapType(k)}, ${mapType(v)}>`
  );
  // Future<T> → Promise<T>
  line = line.replace(/\bFuture<([^>]+)>\??\b/g, (_, t) => `Promise<${mapType(t)}>`);
  // Stream<T> → AsyncIterable<T>
  line = line.replace(/\bStream<([^>]+)>\??\b/g, (_, t) => `AsyncIterable<${mapType(t)}>`);
  // Set<T> → Set<T>
  line = line.replace(/\bSet<([^>]+)>\??\b/g, (_, t) => `Set<${mapType(t)}>`);
  // Iterable<T> → Iterable<T>
  line = line.replace(/\bIterable<([^>]+)>\??\b/g, (_, t) => `Iterable<${mapType(t)}>`);
  
  // Simple type replacements
  for (const [dart, ts] of Object.entries(TYPE_MAP)) {
    if (['List', 'Map', 'Future', 'Stream', 'Set', 'Iterable'].includes(dart)) continue;
    line = line.replace(new RegExp(`\\b${dart}\\b`, 'g'), ts);
  }
  
  return line;
}

function mapType(dartType: string): string {
  const t = dartType.trim();
  const mapped = TYPE_MAP[t];
  if (mapped) return mapped;
  
  // List<T> in nested generics
  if (t.startsWith('List<')) {
    const inner = t.slice(5, -1);
    return `${mapType(inner)}[]`;
  }
  if (t.startsWith('Map<')) {
    const inner = t.slice(4, -1);
    const comma = findComma(inner);
    if (comma >= 0) {
      return `Record<${mapType(inner.slice(0, comma))}, ${mapType(inner.slice(comma + 1))}>`;
    }
  }
  if (t.startsWith('Future<')) {
    return `Promise<${mapType(t.slice(7, -1))}>`;
  }
  
  return t; // keep as-is (class names, etc.)
}

function findComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>') depth--;
    else if (s[i] === ',' && depth === 0) return i;
  }
  return -1;
}

function convertStringInterpolation(line: string): string {
  // '$variable' → `${variable}` (single quotes with interpolation)
  // Already handled by most cases, but ensure template literals for complex cases
  if (line.includes("'") && line.includes('$')) {
    // Simple case: 'Hello $name' → `Hello ${name}`
    line = line.replace(/'([^']*\$[^']*)'(?=[^']*(?:'|$))/g, (match, content) => {
      if (!content.includes('$')) return match;
      const converted = content
        .replace(/\$\{([^}]+)\}/g, '${$1}')
        .replace(/\$(\w+)/g, '${$1}');
      return '`' + converted + '`';
    });
  }
  return line;
}

function toCamelCase(s: string): string {
  return s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
}

// ── Main transpiler ───────────────────────────────────────────────────────────

export function transpileDartToTypeScript(
  dartCode:  string,
  filePath:  string,
  fileType:  string,
): TranspileResult {
  const warnings: string[] = [];
  const ctx: TranspileContext = { warnings, hasCopyWith: false, className: '' };
  
  const sourceLines = dartCode.split('\n');
  const outputLines: string[] = [];
  
  // Extract class name
  const classMatch = /(?:abstract\s+)?class\s+(\w+)/.exec(dartCode);
  ctx.className = classMatch?.[1] ?? 'Unknown';
  
  // Track state
  let inMultilineComment = false;
  let transformedCount   = 0;
  
  // Header
  outputLines.push(`// [CodeMorph] Transpiled from Dart: ${filePath}`);
  outputLines.push(`// Dart→TypeScript conversion — review before use`);
  outputLines.push('');
  
  for (let i = 0; i < sourceLines.length; i++) {
    const raw = sourceLines[i] ?? '';
    
    // Multi-line comment handling
    if (inMultilineComment) {
      outputLines.push(raw);
      if (raw.includes('*/')) inMultilineComment = false;
      continue;
    }
    if (raw.trimStart().startsWith('/*') && !raw.includes('*/')) {
      inMultilineComment = true;
      outputLines.push(raw);
      continue;
    }
    
    // Empty lines
    if (raw.trim() === '') {
      outputLines.push('');
      continue;
    }
    
    const transpiled = transpileLine(raw, ctx);
    outputLines.push(transpiled);
    if (transpiled !== raw) transformedCount++;
  }
  
  // Ajouter les exports nécessaires selon fileType
  const hasExport = outputLines.some((l) => l.includes('export '));
  if (!hasExport) {
    outputLines.push('');
    outputLines.push(generateExport(ctx.className, fileType));
  }
  
  const content  = outputLines.join('\n');
  const coverage = sourceLines.length > 0
    ? Math.round((transformedCount / sourceLines.length) * 100)
    : 0;
  
  return {
    content,
    warnings,
    lines:    outputLines.length,
    coverage,
  };
}

function generateExport(className: string, fileType: string): string {
  if (!className || className === 'Unknown') return '';
  
  switch (fileType) {
    case 'screen':
    case 'component':
      return `export default ${className};`;
    case 'store':
      return `export const use${className}Store = create<${className}State>((set) => ({ ...defaultState, ...actions(set) }));`;
    case 'model':
      return `export type { ${className} };`;
    case 'service':
    case 'repository':
      return `export const ${className.charAt(0).toLowerCase() + className.slice(1)} = new ${className}();\nexport default ${className.charAt(0).toLowerCase() + className.slice(1)};`;
    default:
      return `export default ${className};`;
  }
}

// ── Transpiler rapide pour fichiers entiers ───────────────────────────────────

export function generateTypeScriptFromDart(
  dartCode:    string,
  filePath:    string,
  fileType:    'screen' | 'store' | 'service' | 'repository' | 'model' | 'component' | 'hook' | 'util' | 'config',
  targetPath:  string,
): string {
  const result = transpileDartToTypeScript(dartCode, filePath, fileType);
  
  // Ajouter wrapper selon le type de fichier
  if (fileType === 'screen' || fileType === 'component') {
    return wrapAsReactNativeComponent(result.content, filePath, result.warnings);
  }
  if (fileType === 'store') {
    return wrapAsZustandStore(result.content, filePath);
  }
  
  void targetPath;
  return result.content;
}

function wrapAsReactNativeComponent(content: string, _sourcePath: string, warnings: string[]): string {
  // Extraire le nom de la classe principale
  void /class\s+(\w+)(?:Screen|Widget|Page)?/.exec(content); // unused extraction
  const hasReactImport = content.includes("import React");
  const hasRNImport = content.includes("from 'react-native'");
  
  const header = [
    !hasReactImport ? "import React, { useState, useEffect } from 'react';" : '',
    !hasRNImport ? "import { View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, ActivityIndicator } from 'react-native';" : '',
    "import { useRouter } from 'expo-router';",
    warnings.length > 0 ? `// Warnings: ${warnings.slice(0, 2).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  
  return `${header}\n\n${content}`;
}

function wrapAsZustandStore(content: string, _sourcePath: string): string {
  const hasZustand = content.includes("from 'zustand'");
  const header = !hasZustand ? "import { create } from 'zustand';\nimport AsyncStorage from '@react-native-async-storage/async-storage';\n\n" : '';
  return header + content;
}
