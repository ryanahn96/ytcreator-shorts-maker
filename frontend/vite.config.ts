import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { defineConfig, Plugin } from 'vite';

const BACKEND_PORT = process.env.BACKEND_PORT || '5000';
const BACKEND_TARGET = `http://127.0.0.1:${BACKEND_PORT}`;

function checkBackendAlive(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/api/health`,
      { timeout: 600 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function pythonBackendPlugin(): Plugin {
  let pyProc: ChildProcess | null = null;

  return {
    name: 'python-backend-launcher',
    configureServer(server) {
      checkBackendAlive(BACKEND_PORT).then((alive) => {
        if (alive) {
          return;
        }
        const rootDir = path.resolve(__dirname, '..');
        pyProc = spawn('uv', ['run', 'python', '-m', 'yt.server'], {
          cwd: rootDir,
          env: { ...process.env, BACKEND_PORT },
          stdio: 'inherit',
        });
        pyProc.on('error', () => {
          // Fallback to .venv/bin/python or python3 if uv is not on PATH
          const venvPy = path.join(rootDir, '.venv', 'bin', 'python');
          const pyCmd = fs.existsSync(venvPy) ? venvPy : 'python3';
          pyProc = spawn(pyCmd, ['-m', 'yt.server'], {
            cwd: rootDir,
            env: { ...process.env, BACKEND_PORT },
            stdio: 'inherit',
          });
        });
      });

      const cleanup = () => {
        if (pyProc && !pyProc.killed) {
          pyProc.kill();
          pyProc = null;
        }
      };

      server.httpServer?.on('close', cleanup);
      process.on('exit', cleanup);
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), pythonBackendPlugin()],
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: BACKEND_TARGET,
          changeOrigin: true,
          xfwd: true,
          timeout: 300000,
          proxyTimeout: 300000,
        },
      },
    },
  };
});
