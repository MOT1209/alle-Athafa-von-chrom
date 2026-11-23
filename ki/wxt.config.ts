import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// VideoMind AI - Chrome MV3 via WXT.
// Local-first: the only host permissions are the loopback Ollama server.
// Remote AI providers (future phases) must be optional_host_permissions, never required.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  outDir: '.output',
  manifest: {
    name: 'VideoMind AI',
    short_name: 'VideoMind',
    description:
      'Turn videos into searchable knowledge with local AI: summaries, chat, transcripts and learning tools. No paid APIs required.',
    permissions: ['storage', 'alarms'],
    host_permissions: ['http://localhost:11434/*', 'http://127.0.0.1:11434/*'],
    icons: {
      16: 'icon-16.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    action: {
      default_title: 'VideoMind AI',
      default_icon: {
        16: 'icon-16.png',
        48: 'icon-48.png',
        128: 'icon-128.png',
      },
    },
    minimum_chrome_version: '120',
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
