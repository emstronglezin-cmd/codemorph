module.exports = {
  apps: [{
    name: 'ai-engine',
    script: 'node',
    args: 'dist/index.js',
    cwd: '/home/user/codemorph/ai-engine',
    env: {
      NODE_ENV:          'development',
      AI_PORT:           '5000',
      LOG_LEVEL:         'warn',
      AI_ENGINE_SECRET:  '',
      GROQ_API_KEY:      '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',
    },
    watch: false,
    instances: 1,
    exec_mode: 'fork',
  }]
};
