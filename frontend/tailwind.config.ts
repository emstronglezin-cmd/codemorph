import type { Config } from 'tailwindcss';
import { fontFamily } from 'tailwindcss/defaultTheme';

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    container: {
      center: true,
      padding: { DEFAULT: '1rem', sm: '1.5rem', lg: '2rem' },
      screens: { '2xl': '1400px' },
    },
    extend: {
      // ── Design Tokens ──────────────────────────────────
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',

        // Brand
        brand: {
          50:  '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',   // primary
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },

        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // Semantic
        success: {
          DEFAULT: '#10b981',
          foreground: '#ffffff',
          muted: '#d1fae5',
        },
        warning: {
          DEFAULT: '#f59e0b',
          foreground: '#ffffff',
          muted: '#fef3c7',
        },
        error: {
          DEFAULT: '#ef4444',
          foreground: '#ffffff',
          muted: '#fee2e2',
        },
        info: {
          DEFAULT: '#3b82f6',
          foreground: '#ffffff',
          muted: '#dbeafe',
        },

        // Surface layers (Vercel-style)
        surface: {
          0:  'hsl(var(--surface-0))',
          1:  'hsl(var(--surface-1))',
          2:  'hsl(var(--surface-2))',
          3:  'hsl(var(--surface-3))',
        },
      },

      // ── Typography ────────────────────────────────────
      fontFamily: {
        sans: ['Inter var', 'Inter', ...fontFamily.sans],
        mono: ['JetBrains Mono', 'Fira Code', ...fontFamily.mono],
        display: ['Cal Sans', 'Inter var', ...fontFamily.sans],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '1rem' }],
        xs:   ['0.75rem',  { lineHeight: '1rem' }],
        sm:   ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem',     { lineHeight: '1.5rem' }],
        lg:   ['1.125rem', { lineHeight: '1.75rem' }],
        xl:   ['1.25rem',  { lineHeight: '1.75rem' }],
        '2xl':['1.5rem',   { lineHeight: '2rem' }],
        '3xl':['1.875rem', { lineHeight: '2.25rem' }],
        '4xl':['2.25rem',  { lineHeight: '2.5rem' }],
        '5xl':['3rem',     { lineHeight: '1.15' }],
        '6xl':['3.75rem',  { lineHeight: '1.1' }],
        '7xl':['4.5rem',   { lineHeight: '1.05' }],
        '8xl':['6rem',     { lineHeight: '1' }],
      },
      fontWeight: {
        thin:       '100',
        extralight: '200',
        light:      '300',
        normal:     '400',
        medium:     '500',
        semibold:   '600',
        bold:       '700',
        extrabold:  '800',
        black:      '900',
      },

      // ── Spacing ───────────────────────────────────────
      spacing: {
        '4.5': '1.125rem',
        '5.5': '1.375rem',
        '6.5': '1.625rem',
        '7.5': '1.875rem',
        '13':  '3.25rem',
        '15':  '3.75rem',
        '18':  '4.5rem',
        '22':  '5.5rem',
        '26':  '6.5rem',
        '30':  '7.5rem',
        '34':  '8.5rem',
        '68':  '17rem',
        '76':  '19rem',
        '84':  '21rem',
        '88':  '22rem',
        '92':  '23rem',
        '100': '25rem',
        '104': '26rem',
        '108': '27rem',
        '112': '28rem',
      },

      // ── Border Radius ─────────────────────────────────
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      // ── Shadows ───────────────────────────────────────
      boxShadow: {
        'xs':   '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        'sm':   '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        'md':   '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        'lg':   '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
        'xl':   '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
        '2xl':  '0 25px 50px -12px rgb(0 0 0 / 0.25)',
        'inner':'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
        // Stripe-style colored glows
        'glow-sm':     '0 0 10px rgb(99 102 241 / 0.15)',
        'glow-md':     '0 0 20px rgb(99 102 241 / 0.2)',
        'glow-lg':     '0 0 40px rgb(99 102 241 / 0.25)',
        'glow-error':  '0 0 20px rgb(239 68 68 / 0.2)',
        'glow-success':'0 0 20px rgb(16 185 129 / 0.2)',
        // Vercel-style card shadows
        'card':        '0 0 0 1px hsl(var(--border)), 0 2px 4px 0 rgb(0 0 0 / 0.04)',
        'card-hover':  '0 0 0 1px hsl(var(--primary)), 0 8px 24px -4px rgb(0 0 0 / 0.08)',
      },

      // ── Animations ────────────────────────────────────
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to:   { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to:   { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-out': {
          from: { opacity: '1', transform: 'translateY(0)' },
          to:   { opacity: '0', transform: 'translateY(4px)' },
        },
        'slide-in-from-right': {
          from: { transform: 'translateX(100%)' },
          to:   { transform: 'translateX(0)' },
        },
        'slide-out-to-right': {
          from: { transform: 'translateX(0)' },
          to:   { transform: 'translateX(100%)' },
        },
        'shimmer': {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-ring': {
          '0%':   { boxShadow: '0 0 0 0 rgb(99 102 241 / 0.4)' },
          '100%': { boxShadow: '0 0 0 12px rgb(99 102 241 / 0)' },
        },
        'spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to:   { transform: 'rotate(360deg)' },
        },
        'count-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'accordion-down':        'accordion-down 0.2s ease-out',
        'accordion-up':          'accordion-up 0.2s ease-out',
        'fade-in':               'fade-in 0.2s ease-out',
        'fade-out':              'fade-out 0.2s ease-out',
        'slide-in-from-right':   'slide-in-from-right 0.3s ease-out',
        'slide-out-to-right':    'slide-out-to-right 0.3s ease-out',
        'shimmer':               'shimmer 2s linear infinite',
        'pulse-ring':            'pulse-ring 1.5s ease-out infinite',
        'spin-slow':             'spin-slow 3s linear infinite',
        'count-up':              'count-up 0.5s ease-out',
      },

      // ── Transitions ───────────────────────────────────
      transitionTimingFunction: {
        'spring':  'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        'smooth':  'cubic-bezier(0.4, 0, 0.2, 1)',
        'swift':   'cubic-bezier(0.55, 0, 0.1, 1)',
        'bouncy':  'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
  ],
};

export default config;
