// Options page entry point
import { mountOptionsApp } from './OptionsApp';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    mountOptionsApp(document.getElementById('root')!);
  });
} else {
  mountOptionsApp(document.getElementById('root')!);
}
