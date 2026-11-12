const socketIo = require('socket.io');

let io;

const allowedOrigins = [
  'https://snbtradingco.in',
  'https://www.snbtradingco.in',
  'https://zudo-sellerpanel-final.vercel.app',
  'https://zudo-adminpanel.vercel.app'
];

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return allowedOrigins.includes(origin);
};

module.exports = {
  init: (httpServer) => {
    io = socketIo(httpServer, {
      cors: {
        origin: (origin, callback) => {
          if (isOriginAllowed(origin)) {
            callback(null, true);
          } else {
            callback(null, true); // Permissive in dev to avoid WebSocket aborts
          }
        },
        credentials: true
      },
      transports: ['polling', 'websocket'],
      allowEIO3: true
    });
    return io;
  },
  getIO: () => {
    if (!io) {
      throw new Error('Socket.io not initialized!');
    }
    return io;
  },
  isOriginAllowed
};
