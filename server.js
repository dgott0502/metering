require("dotenv").config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const { check, validationResult } = require("express-validator");
const { Parser } = require("json2csv");
const multer = require("multer");
const csvParser = require("csv-parser");
const fs = require("fs");
const cron = require("node-cron");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

app.use(session({
  secret: "your-very-secret-key", // Replace with a strong secret in production
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 5 * 60 * 1000, secure: false }
}));

app.use(express.static('public'));
const upload = multer({ dest: "uploads/" });

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/metering");

// ----- Meter Schema & Model -----
const meterSchema = new mongoose.Schema({
  meterId: { type: String, unique: true }
});
const Meter = mongoose.model("Meter", meterSchema);

// ----- Tenant Schema & Model -----
const tenantSchema = new mongoose.Schema({
  unitNumber: String,
  meterIds: [String],
  accountNumber: String,
  contactName: String,
  email: String,
  history: [
    {
      meter: String,
      date: { type: Date, default: Date.now },
      description: String,
      meterReadings: [{ type: mongoose.Schema.Types.ObjectId, ref: "MeterReading" }]
    }
  ]
});
const Tenant = mongoose.model("Tenant", tenantSchema);

// ----- MeterReading Schema & Model -----
const meterReadingSchema = new mongoose.Schema({
  meter: String,
  date: String,
  time: String,
  kWHNet: Number
});
meterReadingSchema.index({ meter: 1, date: 1, time: 1 }, { unique: true });
const MeterReading = mongoose.model("MeterReading", meterReadingSchema);

// ----- User Schema & Model -----
const User = require("./models/User.js"); // Ensure this includes accountNumber & role fields

// ----- Metering Code -----
const API_URL = "https://api.dentcloud.io/v1";
const HEADERS = {
  "x-api-key": process.env.API_KEY,
  "x-key-id": process.env.KEY_ID
};

const CACHE_EXPIRATION = 60 * 60 * 1000;
let cachedMeters = { data: [], lastUpdated: 0 };
let cachedTopics = { data: [], lastUpdated: 0 };

function logApiRequest(endpoint, fullUrl, params, response) {
  console.log("\n=====================================");
  console.log(`🚀 OUTGOING API Request: ${fullUrl}`);
  console.log("📌 Endpoint:", endpoint);
  console.log("📌 Parameters:", params);
  console.log("✅ API Response:", JSON.stringify(response, null, 2));
  console.log("=====================================\n");
}

async function loadMeters() {
  if (Date.now() - cachedMeters.lastUpdated > CACHE_EXPIRATION) {
    try {
      const params = { request: "getMeters" };
      const fullUrl = `${API_URL}?${new URLSearchParams(params).toString()}`;
      const response = await axios.get(fullUrl, { headers: HEADERS });
      const meters = response.data.meters || [];
      cachedMeters = { data: meters, lastUpdated: Date.now() };
      logApiRequest("getMeters", fullUrl, params, response.data);
      for (const meterId of meters) {
        await Meter.updateOne({ meterId }, { $setOnInsert: { meterId } }, { upsert: true });
      }
    } catch (error) {
      console.error("Error fetching meters:", error.message);
    }
  }
}

async function loadTopics() {
  if (Date.now() - cachedTopics.lastUpdated > CACHE_EXPIRATION) {
    try {
      const params = { request: "getTopics" };
      const fullUrl = `${API_URL}?${new URLSearchParams(params).toString()}`;
      const response = await axios.get(fullUrl, { headers: HEADERS });
      cachedTopics = { data: response.data.topics || [], lastUpdated: Date.now() };
      logApiRequest("getTopics", fullUrl, params, response.data);
    } catch (error) {
      console.error("Error fetching topics:", error.message);
    }
  }
}

async function fetchMeterData(params) {
  Object.keys(params).forEach(key => {
    if (params[key] === "" || params[key] === null) delete params[key];
  });
  if (params.topics) {
    params.topics = Array.isArray(params.topics) ? params.topics : [params.topics];
    if (!params.topics[0].startsWith("[")) {
      params.topics = "[" + params.topics.join(",") + "]";
    }
  }
  try {
    const fullUrl = `${API_URL}?${new URLSearchParams(params).toString()}`;
    console.log("\nFULL API REQUEST:", fullUrl);
    const response = await axios.get(fullUrl, { headers: HEADERS });
    logApiRequest("getData", fullUrl, params, response.data);
    return response.data || {};
  } catch (error) {
    console.error("Error fetching meter data from API:", error.message);
    return { success: false, error: error.message };
  }
}

function safeNumber(val) {
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num;
}

function calculateMonthlyConsumption(readings) {
  const monthly = {};
  readings.forEach(record => {
    const monthKey = record.date.substring(0, 7);
    const meter = record.meter;
    if (!monthly[meter]) {
      monthly[meter] = {};
    }
    if (!monthly[meter][monthKey]) {
      monthly[meter][monthKey] = { min: safeNumber(record.kWHNet), max: safeNumber(record.kWHNet) };
    } else {
      monthly[meter][monthKey].min = Math.min(monthly[meter][monthKey].min, safeNumber(record.kWHNet));
      monthly[meter][monthKey].max = Math.max(monthly[meter][monthKey].max, safeNumber(record.kWHNet));
    }
  });
  const consumption = {};
  for (const meter in monthly) {
    consumption[meter] = {};
    for (const month in monthly[meter]) {
      consumption[meter][month] = monthly[meter][month].max - monthly[meter][month].min;
    }
  }
  return { monthly, consumption };
}

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

let jobList = [];
let jobIdCounter = 1;

function scheduleJob(cronExpression, jobType) {
  let task;
  if (jobType === "Load Meters") {
    task = cron.schedule(cronExpression, async () => {
      console.log("Scheduled job: Loading meters...");
      await loadMeters();
    });
  } else if (jobType === "Fetch Meter Data") {
    task = cron.schedule(cronExpression, async () => {
      console.log("Scheduled job: Fetching meter data for all stored meters...");
      try {
        const meterDocs = await Meter.find({});
        for (const doc of meterDocs) {
          const meterId = doc.meterId;
          const params = {
            request: "getData",
            meter: meterId,
            topics: "kWHNet",
            year: new Date().getFullYear(),
            month: ("0" + (new Date().getMonth() + 1)).slice(-2)
          };
          const result = await fetchMeterData(params);
          console.log(`Fetched data for meter ${meterId}:`, result);
          if (result.topics) {
            for (const reading of result.topics) {
              Object.keys(reading).forEach(async key => {
                if (key.startsWith("kWHNet/Elm/")) {
                  const letter = key.substring("kWHNet/Elm/".length);
                  const meterSuffix = meterId + "_" + letter;
                  const filter = { meter: meterSuffix, date: reading.date, time: reading.time };
                  const update = {
                    meter: meterSuffix,
                    date: reading.date,
                    time: reading.time,
                    kWHNet: safeNumber(reading[key])
                  };
                  try {
                    await MeterReading.updateOne(filter, { $setOnInsert: update }, { upsert: true });
                  } catch (err) {
                    if (err.code !== 11000)
                      console.error(`Error upserting meter reading for ${meterSuffix}:`, err);
                  }
                }
              });
            }
          }
        }
      } catch (err) {
        console.error("Error in scheduled fetch of meter data:", err);
      }
    });
  } else {
    return null;
  }
  const job = { id: jobIdCounter++, cronExpression, jobType, task };
  jobList.push(job);
  console.log(`Job scheduled [${job.id}]: ${job.jobType} (${job.cronExpression})`);
  return job;
}

// ----- Public Authentication Routes -----
app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.render("login", { error: "Invalid username or password" });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.render("login", { error: "Invalid username or password" });
    }
    req.session.userId = user._id;
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.render("login", { error: "An error occurred. Please try again." });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ----- Middleware to Attach Logged-In User -----
app.use(async (req, res, next) => {
  if (req.session.userId) {
    try {
      const user = await User.findById(req.session.userId);
      req.user = user;
      res.locals.user = user;
    } catch (err) {
      console.error("Error fetching user:", err);
    }
  }
  next();
});

// ----- Global Authentication Middleware -----
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  next();
}
app.use((req, res, next) => {
  const publicPaths = ["/login", "/logout"];
  if (!req.session.userId && !publicPaths.includes(req.path)) return res.redirect("/login");
  next();
});

// ----- Role-Based Middleware -----
function requireRole(role) {
  return function(req, res, next) {
    if (req.user && req.user.role === role) return next();
    res.status(403).send("Forbidden: You do not have the required permissions.");
  };
}
function requireReporting(req, res, next) {
  if (req.user && (req.user.role === "admin" || req.user.role === "reporting")) return next();
  res.status(403).send("Forbidden: You do not have the required permissions.");
}

// ----- Tenant Routes -----
// List all tenants (for admin/reporting)
app.get("/tenants", requireAuth, requireReporting, async (req, res) => {
  try {
    const tenants = await Tenant.find({});
    res.render("tenants", { tenants });
  } catch (err) {
    res.status(500).send("Error retrieving tenants.");
  }
});

// Show form to create a new tenant
app.get("/tenants/new", requireAuth, async (req, res) => {
  try {
    const tenants = await Tenant.find({});
    let assigned = {};
    tenants.forEach(tenant => {
      tenant.meterIds.forEach(mid => { assigned[mid] = true; });
    });
    const uniqueMeters = await MeterReading.distinct("meter");
    let available = [];
    uniqueMeters.forEach(meter => {
      if (!assigned[meter]) available.push(meter);
    });
    res.render("newTenant", { availableMeters: available });
  } catch (err) {
    res.status(500).send("Error retrieving available meters for new tenant.");
  }
});

// Handle new tenant creation
app.post("/tenants", requireAuth, async (req, res) => {
  try {
    const { unitNumber, meterIds, accountNumber, contactName, email } = req.body;
    const meterIdArray = Array.isArray(meterIds)
      ? meterIds
      : (meterIds ? meterIds.split(",").map(id => id.trim()) : []);
    const tenant = new Tenant({
      unitNumber,
      meterIds: meterIdArray,
      accountNumber,
      contactName,
      email,
      history: []
    });
    await tenant.save();
    res.redirect("/tenants");
  } catch (err) {
    res.status(500).send("Error creating tenant.");
  }
});
// Export Tenant List as CSV
app.get("/tenants/export", async (req, res) => {
  try {
    let tenants = await Tenant.find({}).lean();
    
    // Transform meterIds array into a comma-separated string for each tenant.
    tenants = tenants.map(tenant => {
      tenant.meterIds = tenant.meterIds.join(",");
      return tenant;
    });
    
    const fields = ["unitNumber", "meterIds", "accountNumber", "contactName", "email"];
    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(tenants);
    
    res.header("Content-Type", "text/csv");
    res.attachment("tenants.csv");
    return res.send(csv);
  } catch (err) {
    res.status(500).send("Error exporting tenants.");
  }
});

// Import Tenant List from CSV
app.post("/tenants/import", upload.single("file"), async (req, res) => {
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csvParser())
    .on("data", (data) => results.push(data))
    .on("end", async () => {
      try {
        for (let tenantData of results) {
          // Convert meterIds from a comma-separated string to an array
          if (typeof tenantData.meterIds === "string") {
            tenantData.meterIds = tenantData.meterIds.split(",").map(id => id.trim());
          }
          let existing = await Tenant.findOne({ unitNumber: tenantData.unitNumber });
          if (existing) {
            existing.meterIds = tenantData.meterIds;
            existing.accountNumber = tenantData.accountNumber;
            existing.contactName = tenantData.contactName;
            existing.email = tenantData.email;
            await existing.save();
          } else {
            await Tenant.create(tenantData);
          }
        }
        res.send(`<script>alert("Tenants imported successfully."); window.location.href="/tenants";</script>`);
      } catch (err) {
        res.send(`<script>alert("Error importing tenants."); window.location.href="/tenants";</script>`);
      } finally {
        fs.unlinkSync(req.file.path);
      }
    });
});

// View tenant details
app.get("/tenants/:id", requireAuth, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send("Tenant not found.");
    const meterReadings = await MeterReading.find({ meter: { $in: tenant.meterIds } }).sort({ date: 1, time: 1 });
    res.render("tenantDetail", { tenant, meterReadings });
  } catch (err) {
    res.status(500).send("Error retrieving tenant details.");
  }
});

// Show form to edit a tenant
app.get("/tenants/:id/edit", requireAuth, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send("Tenant not found.");
    const otherTenants = await Tenant.find({ _id: { $ne: tenant._id } });
    let assigned = {};
    otherTenants.forEach(t => {
      t.meterIds.forEach(mid => { assigned[mid] = true; });
    });
    const uniqueMeters = await MeterReading.distinct("meter");
    let available = [];
    uniqueMeters.forEach(meter => {
      if (!assigned[meter]) available.push(meter);
    });
    // Ensure tenant's current meters are included.
    tenant.meterIds.forEach(mid => {
      if (!available.includes(mid)) available.push(mid);
    });
    res.render("editTenant", { tenant, availableMeters: available });
  } catch (err) {
    res.status(500).send("Error retrieving tenant details for edit.");
  }
});

// Handle tenant updates
app.post("/tenants/:id/edit", requireAuth, async (req, res) => {
  try {
    const { unitNumber, meterIds, accountNumber, contactName, email } = req.body;
    const meterIdArray = Array.isArray(meterIds)
      ? meterIds
      : (meterIds ? meterIds.split(",").map(id => id.trim()) : []);
    await Tenant.findByIdAndUpdate(req.params.id, {
      unitNumber,
      meterIds: meterIdArray,
      accountNumber,
      contactName,
      email
    });
    res.redirect("/tenants/" + req.params.id);
  } catch (err) {
    res.status(500).send("Error updating tenant details.");
  }
});
// Handle invoice email for a specific tenant
app.post("/tenants/:id/invoice", requireAuth, async (req, res) => {
  try {
    const { startDate, endDate, costPerKwh } = req.body;
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).send("Tenant not found.");
    
    // Get tenant's meter readings and sort them
    const meterReadings = await MeterReading.find({ meter: { $in: tenant.meterIds } }).sort({ date: 1, time: 1 });
    
    let minKWH = Infinity;
    let maxKWH = -Infinity;
    meterReadings.forEach(r => {
      if ((startDate && r.date < startDate) || (endDate && r.date > endDate)) return;
      const value = safeNumber(r.kWHNet);
      if (value < minKWH) minKWH = value;
      if (value > maxKWH) maxKWH = value;
    });
    if (minKWH === Infinity || maxKWH === -Infinity) {
      return res.status(400).send("No valid meter readings found in the specified date range.");
    }
    
    const totalKWH = maxKWH - minKWH;
    const totalCost = totalKWH * parseFloat(costPerKwh);
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: tenant.email,
      subject: `Invoice for Unit ${tenant.unitNumber}`,
      text: `Hello ${tenant.contactName},

Here is your usage invoice for the period ${startDate} to ${endDate}:
Total kWHNet: ${totalKWH.toFixed(3)} kWh
Cost per kWh: $${parseFloat(costPerKwh).toFixed(2)}
Total Amount Due: $${totalCost.toFixed(2)}

Please remit payment via check.

Thank you,
Metering App Team`
    };
    
    await transporter.sendMail(mailOptions);
    res.send(`<script>alert("Invoice email sent successfully."); window.location.href="/tenants";</script>`);
    
  } catch (err) {
    console.error("Error sending invoice email:", err);
    res.send(`<script>alert("Error sending invoice email."); window.location.href="/tenants";</script>`);
  }
});

// ----- Dashboard Route for Admin/Reporting Users -----
app.get("/dashboard", requireAuth, requireReporting, async (req, res) => {
  try {
    let filterMonth = req.query.month;
    if (!filterMonth) {
      const now = new Date();
      filterMonth = now.toISOString().substring(0, 7);
    }
    // Read page and limit query parameters (defaulting to page 1 and 9 dashboards per page)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 9;

    const tenants = await Tenant.find({});
    let tenantData = [];
    let buildingUsage = 0;
    for (let tenant of tenants) {
      const readings = await MeterReading.find({
        meter: { $in: tenant.meterIds },
        date: { $regex: '^' + filterMonth }
      }).sort({ date: 1, time: 1 });
      let usagePerMeter = {};
      tenant.meterIds.forEach(meter => { usagePerMeter[meter] = { min: Infinity, max: -Infinity }; });
      readings.forEach(r => {
        const meter = r.meter;
        const value = r.kWHNet;
        if (value < usagePerMeter[meter].min) usagePerMeter[meter].min = value;
        if (value > usagePerMeter[meter].max) usagePerMeter[meter].max = value;
      });
      let usageFinal = {};
      let totalUsage = 0;
      for (let meter in usagePerMeter) {
        const group = usagePerMeter[meter];
        if (group.min === Infinity || group.max === -Infinity) {
          usageFinal[meter] = 0;
        } else {
          const usage = group.max - group.min;
          usageFinal[meter] = usage;
          totalUsage += usage;
        }
      }
      buildingUsage += totalUsage;
      tenantData.push({ tenant, usage: usageFinal, totalUsage });
    }

    // Pagination: calculate total pages and slice tenantData for the current page.
    const totalTenants = tenantData.length;
    const totalPages = Math.ceil(totalTenants / limit);
    const paginatedTenantData = tenantData.slice((page - 1) * limit, page * limit);

    res.render("dashboard", { 
      tenantData: paginatedTenantData, 
      buildingUsage, 
      filterMonth,
      currentPage: page,
      totalPages,
      limit
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error generating dashboard");
  }
});


// ----- Account Route: Fixed Dashboard for the Current Year -----
app.get("/account", requireAuth, async (req, res) => {
  if (req.user.role !== "user") return res.redirect("/");
  try {
    const accountNumber = req.user.accountNumber;
    const currentYear = new Date().getFullYear();
    
    // Find all tenants for this account.
    const tenants = await Tenant.find({ accountNumber });
    
    // Collect all meter IDs from these tenants.
    let meterIds = [];
    tenants.forEach(tenant => {
      meterIds.push(...tenant.meterIds);
    });
    meterIds = [...new Set(meterIds)];
    
    // Find all readings for the current year (assuming date format "YYYY-MM-DD")
    const regexYear = '^' + currentYear;
    const readings = await MeterReading.find({
      meter: { $in: meterIds },
      date: { $regex: regexYear }
    }).sort({ date: 1, time: 1 });
    
    // Group readings by month (first 7 characters "YYYY-MM")
    let grouped = {};
    readings.forEach(r => {
      const monthKey = r.date.substring(0, 7);
      const meter = r.meter;
      const value = parseFloat(r.kWHNet) || 0;
      if (!grouped[monthKey]) grouped[monthKey] = {};
      if (!grouped[monthKey][meter]) {
        grouped[monthKey][meter] = { min: value, max: value };
      } else {
        grouped[monthKey][meter].min = Math.min(grouped[monthKey][meter].min, value);
        grouped[monthKey][meter].max = Math.max(grouped[monthKey][meter].max, value);
      }
    });
    
    // Compute usage for each month by summing (max-min) per meter.
    let monthlyUsage = {};
    // Initialize for all 12 months.
    for (let m = 1; m <= 12; m++) {
      let monthStr = m < 10 ? "0" + m : "" + m;
      monthlyUsage[`${currentYear}-${monthStr}`] = 0;
    }
    for (let month in grouped) {
      let monthTotal = 0;
      for (let meter in grouped[month]) {
        monthTotal += grouped[month][meter].max - grouped[month][meter].min;
      }
      monthlyUsage[month] = monthTotal;
    }
    
    // Total usage for the year.
    let totalBuildingUsage = 0;
    for (let key in monthlyUsage) {
      totalBuildingUsage += monthlyUsage[key];
    }
    
    res.render("account", {
      accountNumber,
      currentYear,
      monthlyUsage,
      totalBuildingUsage
    });
    
  } catch (err) {
    console.error("Error generating account dashboard", err);
    res.status(500).send("Error generating account dashboard");
  }
});

// ----- Other Routes (e.g., /fetch-data, /api, etc.) remain unchanged -----

// Fetch Data Route
app.post(
  "/fetch-data",
  [
    check("request").notEmpty().withMessage("Request type is required"),
    check("meter").notEmpty().withMessage("At least one meter must be selected"),
    check("year").optional().isNumeric().withMessage("Year must be a number"),
    check("month").optional().isInt({ min: 1, max: 12 }).withMessage("Month must be between 01-12"),
    check("day").optional().isInt({ min: 1, max: 31 }).withMessage("Day must be between 01-31"),
    check("hour").optional().isInt({ min: 0, max: 23 }).withMessage("Hour must be between 00-23"),
    check("topics").notEmpty().withMessage("At least one topic must be selected")
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });
    
    if (req.body.topics && !Array.isArray(req.body.topics)) {
      req.body.topics = [req.body.topics];
    }
    
    let meterList = Array.isArray(req.body.meter) ? req.body.meter : [req.body.meter];
    let allMeterData = [];
    
    for (const meterId of meterList) {
      let paramsForMeter = { ...req.body, meter: meterId };
      if (!paramsForMeter.day) delete paramsForMeter.day;
      if (!paramsForMeter.hour) delete paramsForMeter.hour;
      
      const result = await fetchMeterData(paramsForMeter);
      if (result.topics) {
        allMeterData.push(result.topics);
      } else {
        allMeterData.push([result]);
      }
    }
    const combinedTopics = allMeterData.flat();
    const meterData = { topics: combinedTopics };
    
    // Process meterData and update readings...
    for (const reading of meterData.topics) {
      Object.keys(reading).forEach(async key => {
        if (key.startsWith("kWHNet/Elm/")) {
          const letter = key.substring("kWHNet/Elm/".length);
          const meterSuffix = req.body.meter + "_" + letter;
          const filter = { meter: meterSuffix, date: reading.date, time: reading.time };
          const update = {
            meter: meterSuffix,
            date: reading.date,
            time: reading.time,
            kWHNet: safeNumber(reading[key])
          };
          try {
            await MeterReading.updateOne(filter, { $setOnInsert: update }, { upsert: true });
          } catch (err) {
            if (err.code !== 11000)
              console.error(`Error upserting meter reading for ${meterSuffix}:`, err);
          }
        }
      });
    }
    
    let combinedReadings = [];
    meterData.topics.forEach(reading => {
      Object.keys(reading).forEach(key => {
        if (key.startsWith("kWHNet/Elm/")) {
          const letter = key.substring("kWHNet/Elm/".length);
          combinedReadings.push({
            date: reading.date,
            meter: req.body.meter + "_" + letter,
            kWHNet: safeNumber(reading[key])
          });
        }
      });
    });
    
    const monthlyResult = calculateMonthlyConsumption(combinedReadings);
    const monthlyConsumption = monthlyResult.consumption;
    const monthlyDetails = monthlyResult.monthly;
    const costPerKwh = 0.10;
    
    if (req.body.meter) {
      try {
        const tenant = await Tenant.findOne({ meterIds: req.body.meter });
        if (tenant) {
          const readings = await MeterReading.find({ meter: req.body.meter });
          const readingIds = readings.map(r => r._id);
          tenant.history.push({
            meter: req.body.meter,
            description: "Meter readings fetched on " + new Date().toLocaleString(),
            meterReadings: readingIds
          });
          await tenant.save();
        }
      } catch (err) {
        console.error("Error updating tenant history for meter:", err);
      }
    }
    
    res.render("api", {
      meters: cachedMeters.data,
      availableTopics: cachedTopics.data,
      meterData,
      queryParams: req.body,
      monthlyConsumption,
      monthlyDetails,
      costPerKwh,
      cronSchedule: jobList.map(job => `${job.jobType}: ${job.cronExpression}`).join(" | "),
      newLinesCount: 0
    });
  }
);

// ----- Home Route -----
app.get("/", requireAuth, (req, res) => {
  res.render("index");
});

// ----- API Route -----
app.get("/api", requireAuth, async (req, res) => {
  await loadMeters();
  await loadTopics();
  res.render("api", {
    meters: cachedMeters.data,
    availableTopics: cachedTopics.data,
    meterData: {},
    queryParams: {},
    monthlyConsumption: {},
    monthlyDetails: {},
    costPerKwh: 0.21,
    cronSchedule: jobList.map(job => `${job.jobType}: ${job.cronExpression}`).join(" | ")
  });
});

// ----- User Management Routes -----
app.get("/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const users = await User.find({});
    res.render("users", { users });
  } catch (err) {
    res.status(500).send("Error retrieving users.");
  }
});

app.get("/users/new", requireAuth, (req, res) => {
  res.render("newUser", { error: null });
});

app.post("/users/new", requireAuth, async (req, res) => {
  const { username, password, accountNumber } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword, accountNumber });
    res.redirect("/users");
  } catch (err) {
    console.error(err);
    res.render("newUser", { error: "Error creating user. Username may already exist." });
  }
});

app.post("/users/:id/update", requireAuth, requireRole("admin"), async (req, res) => {
  const { role, newPassword, accountNumber } = req.body;
  try {
    let updateFields = { role, accountNumber };
    if (newPassword && newPassword.trim().length > 0) {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      updateFields.password = hashedPassword;
    }
    await User.findByIdAndUpdate(req.params.id, updateFields);
    res.redirect("/users");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating user.");
  }
});

// ----- Routes for Admin/Reporting Users -----
app.get("/tenants/email", async (req, res) => {
  const tenants = await Tenant.find({});
  res.render("tenantsEmail", { tenants });
});

app.get("/tenants/csv", async (req, res) => {
  await loadMeters();
  const tenants = await Tenant.find({});
  let assigned = {};
  tenants.forEach(tenant => {
    tenant.meterIds.forEach(mid => { assigned[mid] = true; });
  });
  let available = [];
  cachedMeters.data.forEach(baseMeter => {
    if (!assigned[baseMeter + "_A"]) available.push(baseMeter + "_A");
    if (!assigned[baseMeter + "_B"]) available.push(baseMeter + "_B");
  });
  res.render("tenantsCsv", { availableMeters: available, tenants });
});

// ----- Start the Server and Create/Update Default Admin User if Needed -----
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await loadMeters();
  await loadTopics();
  const adminUser = await User.findOne({ username: "Admin" });
  if (!adminUser) {
    const hashedPassword = await bcrypt.hash("Metering", 10);
    await User.create({ username: "Admin", password: hashedPassword, role: "admin" });
    console.log("Default admin user created: username 'Admin', password 'Metering'");
  } else if (adminUser.role !== "admin") {
    adminUser.role = "admin";
    await adminUser.save();
    console.log("Admin user updated with role 'admin'");
  }
});
