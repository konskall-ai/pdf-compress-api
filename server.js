require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const {
  ServicePrincipalCredentials,
  PDFServices,
  MimeType,
  CompressPDFJob,
  CompressPDFParams,
  CompressionLevel,
  CompressPDFResult,
  SDKError,
  ServiceUsageError,
  ServiceApiError
} = require('@adobe/pdfservices-node-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['https://konskall.github.io/smartpdfcompressor','http://localhost:3000']
}));
app.use(express.static('public'));
app.use(express.json());

// Configure multer για upload
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Μόνο PDF αρχεία επιτρέπονται'));
    }
  }
});

// Endpoint για συμπίεση PDF
app.post('/api/compress', upload.single('pdf'), async (req, res) => {
  let inputPath = null;
  let outputPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Δεν βρέθηκε PDF αρχείο' });
    }

    inputPath = req.file.path;
    const compressionLevel = req.body.compressionLevel || 'MEDIUM';

    // Validate compression level
    const validLevels = ['LOW', 'MEDIUM', 'HIGH'];
    if (!validLevels.includes(compressionLevel)) {
      throw new Error('Μη έγκυρο επίπεδο συμπίεσης');
    }

    console.log(`Συμπίεση PDF με επίπεδο: ${compressionLevel}`);

    // Setup Adobe credentials
    const credentials = new ServicePrincipalCredentials({
      clientId: process.env.PDF_SERVICES_CLIENT_ID,
      clientSecret: process.env.PDF_SERVICES_CLIENT_SECRET
    });

    // Create PDF Services instance
    const pdfServices = new PDFServices({ credentials });

    // Upload input file
    const readStream = fs.createReadStream(inputPath);
    const inputAsset = await pdfServices.upload({
      readStream,
      mimeType: MimeType.PDF
    });

    // Set compression parameters
    const params = new CompressPDFParams({
      compressionLevel: CompressionLevel[compressionLevel]
    });

    // Create and submit job
    const job = new CompressPDFJob({ inputAsset, params });
    const pollingURL = await pdfServices.submit({ job });
    const pdfServicesResponse = await pdfServices.getJobResult({
      pollingURL,
      resultType: CompressPDFResult
    });

    // Get compressed PDF
    const resultAsset = pdfServicesResponse.result.asset;
    const streamAsset = await pdfServices.getContent({ asset: resultAsset });

    // Save to temp file
    outputPath = path.join('uploads', `compressed-${Date.now()}.pdf`);
    const outputStream = fs.createWriteStream(outputPath);

    await new Promise((resolve, reject) => {
      streamAsset.readStream.pipe(outputStream);
      outputStream.on('finish', resolve);
      outputStream.on('error', reject);
    });

    // Get file sizes
    const originalSize = fs.statSync(inputPath).size;
    const compressedSize = fs.statSync(outputPath).size;
    const reduction = originalSize - compressedSize;
    const reductionPercent = originalSize > 0 
      ? ((reduction / originalSize) * 100).toFixed(1) 
      : '0.0';

    console.log(`Συμπίεση ολοκληρώθηκε: ${originalSize} → ${compressedSize} bytes (${reductionPercent}%)`);

    // Send compressed file
    res.download(outputPath, 'compressed.pdf', (err) => {
      // Cleanup temp files
      if (inputPath) fs.unlinkSync(inputPath);
      if (outputPath) fs.unlinkSync(outputPath);

      if (err) {
        console.error('Σφάλμα κατά την αποστολή αρχείου:', err);
      }
    });

  } catch (err) {
    console.error('Σφάλμα συμπίεσης:', err);

    // Cleanup on error
    if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    let errorMessage = 'Σφάλμα κατά τη συμπίεση του PDF';
    
    if (err instanceof SDKError || err instanceof ServiceUsageError) {
      errorMessage = 'Σφάλμα Adobe API: ' + err.message;
    } else if (err instanceof ServiceApiError) {
      errorMessage = 'Σφάλμα υπηρεσίας Adobe: ' + err.message;
    }

    res.status(500).json({ error: errorMessage });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Create uploads directory if not exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📄 Adobe PDF Services API ready`);
});
