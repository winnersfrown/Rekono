import { Sequelize } from "sequelize";
import { settings } from "./config.js";

let sequelize;

if (settings.databaseUrl.startsWith("sqlite:")) {
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage: settings.databaseUrl.slice("sqlite:".length),
    logging: false,
  });
} else {
  sequelize = new Sequelize(settings.databaseUrl, {
    dialect: "postgres",
    logging: false,
    // Row-level security puts every request inside a transaction (see
    // rls.js), so a connection is held for the life of a request rather
    // than just the life of a query. The default pool of 5 would start
    // queuing requests behind each other at very modest concurrency.
    pool: { max: 20, min: 0, acquire: 30000, idle: 10000 },
  });
}

export { sequelize };
