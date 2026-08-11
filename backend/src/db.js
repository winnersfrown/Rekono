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
  sequelize = new Sequelize(settings.databaseUrl, { dialect: "postgres", logging: false });
}

export { sequelize };
