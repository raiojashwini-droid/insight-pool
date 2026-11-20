const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { Readable } = require('stream');
const { v2: cloudinary } = require('cloudinary');

const ROOT_PUBLIC_DIR = path.join(__dirname, '../../public');
const SCREENSHOT_UPLOAD_DIR = path.join(ROOT_PUBLIC_DIR, 'uploads/screenshots');

function isCloudinaryConfigured() {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) return false;
    if (apiKey.includes('your_') || cloudName.includes('your_') || apiSecret.includes('your_')) return false;
    return true;
}

function configureCloudinary() {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

function ensureLocalUploadDir() {
    if (!fs.existsSync(SCREENSHOT_UPLOAD_DIR)) {
        fs.mkdirSync(SCREENSHOT_UPLOAD_DIR, { recursive: true });
    }
}

function getCloudinaryPublicIdFromUrl(url) {
    if (!url || !url.includes('res.cloudinary.com')) return null;
    const uploadMarker = '/upload/';
    const uploadIdx = url.indexOf(uploadMarker);
    if (uploadIdx === -1) return null;

    let tail = url.substring(uploadIdx + uploadMarker.length);
    tail = tail.replace(/^v\d+\//, '');
    tail = tail.split('?')[0];
    const dotIdx = tail.lastIndexOf('.');
    if (dotIdx > -1) tail = tail.substring(0, dotIdx);

    return tail || null;
}

async function processImageBuffer(buffer, options = {}) {
    const { format = 'jpeg', quality = 70, blur = false } = options;
    let pipeline = sharp(buffer);

    if (blur) pipeline = pipeline.blur(15);

    if (format === 'webp') {
        return pipeline.webp({ quality }).toBuffer();
    }
    return pipeline.jpeg({ quality }).toBuffer();
}

async function uploadImageBuffer(buffer, options = {}) {
    const {
        format = 'jpeg',
        quality = 70,
        folder = 'insightful/screenshots',
        fileNamePrefix = 'screenshot',
        useCloudinary = true,
        blur = false
    } = options;

    const processedBuffer = await processImageBuffer(buffer, { format, quality, blur });

    if (useCloudinary && isCloudinaryConfigured()) {
        try {
            configureCloudinary();
            const publicId = `${fileNamePrefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

            const result = await cloudinary.uploader.upload(
                `data:image/${format};base64,${processedBuffer.toString('base64')}`,
                {
                    folder,
                    public_id: publicId,
                    resource_type: 'image'
                }
            );

            return {
                imageUrl: result.secure_url,
                publicId: result.public_id,
                storage: 'cloudinary'
            };
        } catch (cloudErr) {
            console.warn('[imageStorage] Cloudinary upload failed, falling back to local disk storage:', cloudErr.message);
        }
    }

    ensureLocalUploadDir();
    const extension = format === 'webp' ? 'webp' : 'jpeg';
    const fileName = `${fileNamePrefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${extension}`;
    const filePath = path.join(SCREENSHOT_UPLOAD_DIR, fileName);
    fs.writeFileSync(filePath, processedBuffer);

    return {
        imageUrl: `/uploads/screenshots/${fileName}`,
        publicId: null,
        storage: 'local'
    };
}

async function uploadVideoBuffer(buffer, options = {}) {
    const {
        folder = 'insightful/videos',
        fileNamePrefix = 'recording',
        ext = 'webm'
    } = options;

    if (isCloudinaryConfigured()) {
        try {
            configureCloudinary();
            const publicId = `${fileNamePrefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
            const result = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    {
                        folder,
                        public_id: publicId,
                        resource_type: 'video'
                    },
                    (error, res) => {
                        if (error) return reject(error);
                        resolve(res);
                    }
                );
                Readable.from(buffer).pipe(uploadStream);
            });

            return {
                videoUrl: result.secure_url,
                publicId: result.public_id,
                storage: 'cloudinary'
            };
        } catch (cloudErr) {
            console.warn('[imageStorage] Cloudinary video upload failed, falling back to local disk storage:', cloudErr.message);
        }
    }

    const uploadDir = path.join(ROOT_PUBLIC_DIR, 'uploads/videos');
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }
    const filename = `${fileNamePrefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const filepath = path.join(uploadDir, filename);
    fs.writeFileSync(filepath, buffer);

    return {
        videoUrl: `/uploads/videos/${filename}`,
        publicId: null,
        storage: 'local'
    };
}

async function deleteImageByUrl(imageUrl) {
    if (!imageUrl) return;

    if (imageUrl.startsWith('/uploads/')) {
        const filePath = path.join(ROOT_PUBLIC_DIR, imageUrl);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
        return;
    }

    const publicId = getCloudinaryPublicIdFromUrl(imageUrl);
    if (publicId && isCloudinaryConfigured()) {
        try {
            configureCloudinary();
            await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
        } catch (e) {
            console.warn('[imageStorage] Cloudinary image delete failed:', e.message);
        }
    }
}

async function deleteVideoByUrl(videoUrl) {
    if (!videoUrl) return;

    if (videoUrl.startsWith('/uploads/')) {
        const filePath = path.join(ROOT_PUBLIC_DIR, videoUrl);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
        return;
    }

    const publicId = getCloudinaryPublicIdFromUrl(videoUrl);
    if (publicId && isCloudinaryConfigured()) {
        try {
            configureCloudinary();
            await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
        } catch (e) {
            console.warn('[imageStorage] Cloudinary video delete failed:', e.message);
        }
    }
}

module.exports = {
    uploadImageBuffer,
    uploadVideoBuffer,
    deleteImageByUrl,
    deleteVideoByUrl,
    isCloudinaryConfigured
};
