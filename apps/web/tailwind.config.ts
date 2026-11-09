import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#14161A', soft: '#4B5361', faint: '#8A93A2' },
        line: { DEFAULT: '#E4E7EC', strong: '#D0D5DD' },
        surface: { DEFAULT: '#FFFFFF', muted: '#F7F8FA', sunken: '#F1F3F6' },
        accent: { DEFAULT: '#1F5AE0', soft: '#EAF0FD', strong: '#164AB8' },
        positive: { DEFAULT: '#0F7B4F', soft: '#E7F5EE' },
        caution: { DEFAULT: '#9A6400', soft: '#FDF4E3' },
        danger: { DEFAULT: '#B42318', soft: '#FDECEA' },
      },
      fontFamily: { sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px rgba(16,24,40,0.05)', pop: '0 8px 24px rgba(16,24,40,0.10)' },
      borderRadius: { xl2: '14px' },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(4px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: { 'fade-up': 'fade-up 180ms ease-out' },
    },
  },
  plugins: [],
};
export default config;
