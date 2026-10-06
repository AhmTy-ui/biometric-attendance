/**
 * BAMP design tokens.
 * Token names keep the Material-3 vocabulary the templates were built with (so every page adopts the system),
 * but the values are the BAMP enterprise palette: charcoal layered surfaces, off-white text, electric cyan/blue
 * primary, a subtle indigo secondary, emerald for success, amber for warnings and red reserved for critical states.
 */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Surfaces (darkest → lightest) ──
        background: '#08090b',
        surface: '#08090b',
        'surface-dim': '#08090b',
        'surface-container-lowest': '#0b0c0f',
        'surface-container-low': '#111317',
        'surface-container': '#16181d',
        'surface-container-high': '#1c1f25',
        'surface-container-highest': '#24272e',
        'surface-variant': '#24272e',
        'surface-bright': '#2c3038',
        'surface-tint': '#5cc8ff',
        'inverse-surface': '#ededf0',
        'inverse-on-surface': '#1c1f25',

        // ── Text & lines ──
        'on-surface': '#ededf0',
        'on-background': '#ededf0',
        'on-surface-variant': '#a3a7b3',
        outline: '#6c717e',
        'outline-variant': '#30343d',

        // ── Primary: electric cyan / blue ──
        primary: '#5cc8ff',
        'on-primary': '#00263d',
        'primary-container': '#1f7cf2',
        'on-primary-container': '#f4f8ff',
        'inverse-primary': '#3a8ff6',
        'primary-fixed': '#d4ecff',
        'primary-fixed-dim': '#8fd6ff',
        'on-primary-fixed': '#001d33',
        'on-primary-fixed-variant': '#0b4f8f',

        // ── Secondary: subtle indigo (informational) ──
        secondary: '#a5b0ff',
        'on-secondary': '#14196b',
        'secondary-container': '#4b4fd8',
        'on-secondary-container': '#eef0ff',
        'secondary-fixed': '#e0e3ff',
        'secondary-fixed-dim': '#bcc3ff',
        'on-secondary-fixed': '#0b0f4a',
        'on-secondary-fixed-variant': '#2e3399',

        // ── Tertiary: emerald (success / online) ──
        tertiary: '#3ddc97',
        'on-tertiary': '#00331f',
        'tertiary-container': '#0a6b48',
        'on-tertiary-container': '#c9ffe6',
        'tertiary-fixed': '#7af5c0',
        'tertiary-fixed-dim': '#3ddc97',
        'on-tertiary-fixed': '#002113',
        'on-tertiary-fixed-variant': '#005236',

        // ── Warning: amber ──
        warning: '#f5b84a',
        'warning-container': '#3a2a08',

        // ── Error: red, critical only ──
        error: '#ff7a7a',
        'on-error': '#4a0006',
        'error-container': '#4d1418',
        'on-error-container': '#ffd4d4'
      },
      borderRadius: { DEFAULT: '0.375rem', lg: '0.625rem', xl: '0.875rem', '2xl': '1.125rem', full: '9999px', pill: '9999px' },
      spacing: {
        'margin-mobile': '1rem',
        'gutter-dense': '0.5rem',
        margin: '1.5rem',
        'space-xl': '2rem',
        gutter: '1.25rem',
        'space-lg': '1.25rem',
        'space-md': '1rem',
        'space-sm': '0.5rem',
        'space-xs': '0.25rem',
        14: '3.5rem',
        26: '6.5rem'
      },
      boxShadow: {
        card: '0 0 0 1px rgba(255,255,255,0.055), 0 1px 2px rgba(0,0,0,0.5), 0 8px 24px -12px rgba(0,0,0,0.6)',
        'card-hover': '0 0 0 1px rgba(92,200,255,0.22), 0 2px 4px rgba(0,0,0,0.5), 0 16px 32px -14px rgba(0,0,0,0.75)',
        pop: '0 0 0 1px rgba(255,255,255,0.08), 0 20px 48px -12px rgba(0,0,0,0.8)',
        glow: '0 0 0 1px rgba(92,200,255,0.35), 0 0 24px -6px rgba(31,124,242,0.55)'
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
        'label-lg': ['"Inter Variable"', 'sans-serif'],
        'label-md': ['"Inter Variable"', 'sans-serif'],
        'label-sm': ['"Inter Variable"', 'sans-serif'],
        'label-badge': ['"Inter Variable"', 'sans-serif'],
        'headline-xl': ['"Inter Variable"', 'sans-serif'],
        'headline-lg': ['"Inter Variable"', 'sans-serif'],
        'headline-md': ['"Inter Variable"', 'sans-serif'],
        'headline-sm': ['"Inter Variable"', 'sans-serif'],
        'body-lg': ['"Inter Variable"', 'sans-serif'],
        'body-md': ['"Inter Variable"', 'sans-serif'],
        'body-sm': ['"Inter Variable"', 'sans-serif']
      },
      fontSize: {
        'headline-xl': ['32px', { lineHeight: '38px', letterSpacing: '-0.03em', fontWeight: '600' }],
        'headline-lg': ['24px', { lineHeight: '30px', letterSpacing: '-0.025em', fontWeight: '600' }],
        'headline-md': ['18px', { lineHeight: '24px', letterSpacing: '-0.02em', fontWeight: '600' }],
        'headline-sm': ['14px', { lineHeight: '20px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'body-lg': ['15px', { lineHeight: '22px', letterSpacing: '-0.006em', fontWeight: '400' }],
        'body-md': ['13.5px', { lineHeight: '20px', letterSpacing: '-0.003em', fontWeight: '400' }],
        'body-sm': ['12.5px', { lineHeight: '18px', letterSpacing: '0em', fontWeight: '400' }],
        'label-lg': ['13px', { lineHeight: '18px', letterSpacing: '0em', fontWeight: '500' }],
        'label-md': ['12.5px', { lineHeight: '16px', letterSpacing: '0em', fontWeight: '500' }],
        'label-sm': ['11px', { lineHeight: '14px', letterSpacing: '0.02em', fontWeight: '500' }],
        'label-badge': ['10.5px', { lineHeight: '14px', letterSpacing: '0.04em', fontWeight: '600' }]
      },
      transitionTimingFunction: {
        settle: 'cubic-bezier(0.22, 1, 0.36, 1)',
        snap: 'cubic-bezier(0.2, 0, 0, 1)'
      }
    }
  },
  plugins: []
};
