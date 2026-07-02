module.exports = {
  apps: [{
    name: 'codemorph-backend',
    script: 'dist/main.js',
    cwd: '/home/user/codemorph/backend',
    env: {
      NODE_ENV: 'development',
      PORT: 4000,
    },
    watch: false,
    instances: 1,
    exec_mode: 'fork',
    error_file: '/home/user/codemorph/backend/logs/err.log',
    out_file: '/home/user/codemorph/backend/logs/out.log',
  }]
}
