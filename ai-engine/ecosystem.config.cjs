module.exports = {
  apps: [{
    name: 'ai-engine',
    script: 'node',
    args: 'dist/index.js',
    cwd: '/home/user/codemorph/ai-engine',
    env: {
      NODE_ENV: 'development',
      AI_PORT: '5000',
      LOG_LEVEL: 'warn',
    },
    watch: false,
    instances: 1,
    exec_mode: 'fork',
  }]
};
