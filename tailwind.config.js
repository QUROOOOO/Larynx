// Larynx — Tailwind CSS theme configuration
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        accent: '#2563EB',
        accentDim: 'rgba(37, 99, 235, 0.15)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      animation: {
        'spring-in': 'springIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'spring-out': 'springOut 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      keyframes: {
        springIn: {
          '0%': { opacity: '0', transform: 'scale(0.9) translateY(4px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        springOut: {
          '0%': { opacity: '1', transform: 'scale(1) translateY(0)' },
          '100%': { opacity: '0', transform: 'scale(0.9) translateY(4px)' },
        },
      },
    },
  },
  plugins: [],
};
