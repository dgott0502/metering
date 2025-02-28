const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { 
    type: String, 
    enum: ["admin", "reporting", "user"],
    default: "user" 
  },
  accountNumber: { type: String } // New field to store the account number.
});

module.exports = mongoose.model("User", userSchema);
