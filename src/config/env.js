const path = require('path');
const dotenv = require('dotenv');

// Explicitly load .env from backend root, fallback to default cwd
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

// Ensure DATABASE_URL is a valid mysql:// connection string
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.startsWith('mysql://')) {
    const user = process.env.DB_USER || 'root';
    const password = process.env.DB_PASSWORD ? `:${process.env.DB_PASSWORD}` : '';
    const host = process.env.DB_HOST || 'localhost';
    const port = process.env.DB_PORT || 3306;
    const dbName = process.env.DB_NAME || 'employee_db';
    databaseUrl = `mysql://${user}${password}@${host}:${port}/${dbName}`;
    process.env.DATABASE_URL = databaseUrl;
}

module.exports = {
    PORT: process.env.PORT || 5000,
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET || 'supersecretkey',
    NODE_ENV: process.env.NODE_ENV || 'development',
};
