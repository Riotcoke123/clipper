module.exports = {
  apps: [
    {
      name: 'clipper',
      script: 'clipper.js',
      cwd: '/root/clipper',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // Log paths
      out_file: '/root/clipper/logs/out.log',
      error_file: '/root/clipper/logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
