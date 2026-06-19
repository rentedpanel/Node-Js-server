module.exports = (err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  // Log full error stack traces on server logs
  console.error(`[SYSTEM_ERROR] HTTP ${statusCode}: ${message}\nStack: ${err.stack}`);
  
  // Respond with a clean JSON payload
  res.status(statusCode).json({
    error: message,
    // Expose stack trace only when running in development environment
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};
