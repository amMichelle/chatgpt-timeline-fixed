const fs = require('fs');
const { ZipArchive } = require('archiver');

const DEFAULT_IGNORES = [
    '.git/**',
    '.gitignore',
    '.cursor/**',
    '.claude/**',
    '.vscode/**',
    'node_modules/**',
    'scripts/**',
    'web/**',
    'build/**',
    'coverage/**',
    'debug/**',
    'dist/**',
    'profiles/**',
    'tmp/**',
    'READMEIMAGE/**',
    '**/.DS_Store',
    '**/Thumbs.db',
    '*.md',
    'package.json',
    'package-lock.json',
    '*.zip',
    '*.crx',
    '*.pem',
    '*.log',
    '.env',
    '.env.*',
    '*.local'
];

function createArchive(root, zipPath, extraIgnores = []) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = new ZipArchive({ zlib: { level: 9 } });

        output.on('close', () => resolve(archive.pointer()));
        output.on('error', reject);
        archive.on('warning', error => error.code === 'ENOENT' ? undefined : reject(error));
        archive.on('error', reject);
        archive.pipe(output);
        archive.glob('**/*', {
            cwd: root,
            dot: true,
            ignore: [...DEFAULT_IGNORES, ...extraIgnores]
        });
        void archive.finalize();
    });
}

module.exports = { createArchive };
