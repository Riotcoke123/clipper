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
      // Auto-restart on crash. min_uptime works together with the app's own
      // update-guard.js: a freshly-updated process that crashes inside its
      // confirmation window restores the pre-update files and exits itself,
      // so PM2's restart here is what actually brings the rolled-back code
      // up — max_restarts caps that loop so a truly broken deploy stops
      // retrying forever instead of spinning.
      autorestart: true,
      max_restarts: 10,
      min_uptime: '15s',
      restart_delay: 3000,
      // Log paths
      out_file: '/root/clipper/logs/out.log',
      error_file: '/root/clipper/logs/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
