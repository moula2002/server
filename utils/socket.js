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
  if (origin.endsWith('.vercel.app')) return true;
  return allowedOrigins.includes(origin);
};

module.exports = {
  init: (httpServer) => {
    io = socketIo(httpServer, {
      cors: {
        origin: (origin, callback) => {
          callback(null, true);
        },
        credentials: true
      },
      transports: ['websocket', 'polling'],
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
