import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
    root: './',
    base: '/dsc/',
    plugins: [react()],
    test: {
        // vitest 대상은 src 하위만 — 루트 *.test.js는 node:test 전용(npm run test:node)
        include: ['src/**/*.test.js'],
        // node 환경에서 누락된 브라우저 전역(localStorage 등) 스텁 — state.js import용
        setupFiles: ['./src/test-setup.js'],
    },
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                excel: resolve(__dirname, 'excel.html'),
                dashboard: resolve(__dirname, 'dashboard.html'),
                classSetup: resolve(__dirname, 'class-setup.html'),
                checkin: resolve(__dirname, 'checkin.html'),
                messages: resolve(__dirname, 'messages.html'),
            },
        },
    },
    server: {
        watch: {
            usePolling: true,
        },
        host: true,
        port: 5174
    }
})
