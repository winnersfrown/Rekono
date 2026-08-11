import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false, unique: true },
    hashedPassword: { type: DataTypes.STRING(256), allowNull: false },
    fullName: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    role: { type: DataTypes.ENUM("owner", "member"), allowNull: false, defaultValue: "owner" },
  },
  { tableName: "users", updatedAt: false, createdAt: "createdAt" }
);
