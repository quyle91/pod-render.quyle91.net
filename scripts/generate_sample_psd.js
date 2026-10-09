const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { writePsd } = require('ag-psd');

async function createPixelDataFromSvg(svgString, width, height) {
  const { data, info } = await sharp(Buffer.from(svgString))
    .resize(width, height)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
  };
}

async function generateSamplePsd() {
  const canvasWidth = 1600;
  const canvasHeight = 2000;

  console.log(`Creating sample PSD canvas: ${canvasWidth}x${canvasHeight}...`);

  // 1. [fixed] Background Frame (1600x2000)
  const bgSvg = `
    <svg width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${canvasWidth}" height="${canvasHeight}" fill="#fafaf9"/>
      <!-- Soft Pastel Background Aura -->
      <circle cx="800" cy="900" r="550" fill="#fef3c7" opacity="0.45"/>
      <circle cx="800" cy="900" r="420" fill="#fed7aa" opacity="0.3"/>
      <!-- Elegant Outer Decorative Border -->
      <rect x="80" y="80" width="1440" height="1840" rx="36" fill="none" stroke="#d6d3d1" stroke-width="4" stroke-dasharray="16 12"/>
      <rect x="100" y="100" width="1400" height="1800" rx="24" fill="none" stroke="#a8a29e" stroke-width="2"/>
      <!-- Bottom Decorative Banner/Ribbon -->
      <path d="M 400 1780 Q 800 1740 1200 1780 Q 800 1820 400 1780 Z" fill="#e7e5e4" opacity="0.7"/>
    </svg>
  `;
  const bgPixels = await createPixelDataFromSvg(bgSvg, canvasWidth, canvasHeight);

  // 2. [group:skin] Mau_Da (Centered head & neck: 600x700 at x:500, y:550)
  const skinWidth = 600;
  const skinHeight = 700;
  const skinX = 500;
  const skinY = 550;

  const createSkinSvg = (skinColor, shadowColor) => `
    <svg width="${skinWidth}" height="${skinHeight}" viewBox="0 0 ${skinWidth} ${skinHeight}" xmlns="http://www.w3.org/2000/svg">
      <!-- Neck -->
      <path d="M 240 450 L 240 680 L 360 680 L 360 450 Z" fill="${shadowColor}"/>
      <path d="M 250 450 L 250 680 L 350 680 L 350 450 Z" fill="${skinColor}"/>
      <!-- Shoulders -->
      <path d="M 120 680 Q 240 560 300 560 Q 360 560 480 680 Z" fill="${skinColor}"/>
      <!-- Head Oval -->
      <ellipse cx="300" cy="320" rx="140" ry="180" fill="${skinColor}"/>
      <!-- Soft Ears -->
      <circle cx="155" cy="330" r="24" fill="${skinColor}"/>
      <circle cx="445" cy="330" r="24" fill="${skinColor}"/>
      <!-- Cute Face Details -->
      <!-- Cheeks Blush -->
      <ellipse cx="230" cy="360" rx="22" ry="14" fill="#f43f5e" opacity="0.22"/>
      <ellipse cx="370" cy="360" rx="22" ry="14" fill="#f43f5e" opacity="0.22"/>
      <!-- Eyes -->
      <ellipse cx="235" cy="315" rx="8" ry="10" fill="#1c1917"/>
      <ellipse cx="365" cy="315" rx="8" ry="10" fill="#1c1917"/>
      <circle cx="238" cy="312" r="3" fill="#ffffff"/>
      <circle cx="368" cy="312" r="3" fill="#ffffff"/>
      <!-- Gentle Smile -->
      <path d="M 275 375 Q 300 395 325 375" fill="none" stroke="#78716c" stroke-width="4" stroke-linecap="round"/>
    </svg>
  `;

  const skinFairSvg = createSkinSvg('#ffdfd2', '#f3bca8');
  const skinMediumSvg = createSkinSvg('#e7b494', '#d49876');
  const skinDarkSvg = createSkinSvg('#8d5524', '#6b3d16');

  const skinFairPixels = await createPixelDataFromSvg(skinFairSvg, skinWidth, skinHeight);
  const skinMediumPixels = await createPixelDataFromSvg(skinMediumSvg, skinWidth, skinHeight);
  const skinDarkPixels = await createPixelDataFromSvg(skinDarkSvg, skinWidth, skinHeight);

  // 3. [group:hair] Kieu_Toc (Centered on head: 700x800 at x:450, y:360)
  const hairWidth = 700;
  const hairHeight = 800;
  const hairX = 450;
  const hairY = 360;

  // 3a. Bob Hairstyle (Brown & Blonde)
  const createBobHairSvg = (mainColor, highlightColor) => `
    <svg width="${hairWidth}" height="${hairHeight}" viewBox="0 0 ${hairWidth} ${hairHeight}" xmlns="http://www.w3.org/2000/svg">
      <!-- Back hair volume -->
      <path d="M 200 300 C 160 480 180 600 240 620 C 300 630 350 480 350 480 C 350 480 400 630 460 620 C 520 600 540 480 500 300 Z" fill="${mainColor}"/>
      <!-- Top Crown & Bangs -->
      <ellipse cx="350" cy="280" rx="190" ry="150" fill="${mainColor}"/>
      <!-- Side Bangs -->
      <path d="M 170 300 Q 180 560 250 560 Q 210 420 250 330 Z" fill="${highlightColor}"/>
      <path d="M 530 300 Q 520 560 450 560 Q 490 420 450 330 Z" fill="${highlightColor}"/>
      <!-- Front Forehead Bangs -->
      <path d="M 220 240 Q 350 290 480 240 Q 420 330 350 320 Q 280 330 220 240 Z" fill="${highlightColor}"/>
    </svg>
  `;

  // 3b. Curly Hairstyle (Long Curly Black)
  const createCurlyHairSvg = (mainColor, highlightColor) => `
    <svg width="${hairWidth}" height="${hairHeight}" viewBox="0 0 ${hairWidth} ${hairHeight}" xmlns="http://www.w3.org/2000/svg">
      <!-- Big Curly Volume -->
      <circle cx="240" cy="300" r="100" fill="${mainColor}"/>
      <circle cx="460" cy="300" r="100" fill="${mainColor}"/>
      <circle cx="350" cy="250" r="130" fill="${mainColor}"/>
      <circle cx="180" cy="440" r="90" fill="${mainColor}"/>
      <circle cx="520" cy="440" r="90" fill="${mainColor}"/>
      <circle cx="210" cy="580" r="80" fill="${mainColor}"/>
      <circle cx="490" cy="580" r="80" fill="${mainColor}"/>
      <circle cx="240" cy="700" r="70" fill="${mainColor}"/>
      <circle cx="460" cy="700" r="70" fill="${mainColor}"/>
      <!-- Front Bangs Curl -->
      <path d="M 240 230 Q 350 290 460 230 Q 350 340 240 230 Z" fill="${highlightColor}"/>
      <!-- Curl C-curves Highlights -->
      <path d="M 180 400 Q 140 460 190 500" fill="none" stroke="${highlightColor}" stroke-width="8" stroke-linecap="round"/>
      <path d="M 520 400 Q 560 460 510 500" fill="none" stroke="${highlightColor}" stroke-width="8" stroke-linecap="round"/>
    </svg>
  `;

  const hairBobBrown = await createPixelDataFromSvg(createBobHairSvg('#5a3825', '#7a4e35'), hairWidth, hairHeight);
  const hairBobBlonde = await createPixelDataFromSvg(createBobHairSvg('#eab308', '#facc15'), hairWidth, hairHeight);
  const hairCurlyBlack = await createPixelDataFromSvg(createCurlyHairSvg('#1c1917', '#44403c'), hairWidth, hairHeight);

  // 4. [slot:icon] Pet_Icon (320x320 at x:640, y:1220)
  const iconSlotWidth = 320;
  const iconSlotHeight = 320;
  const iconSlotX = 640;
  const iconSlotY = 1220;

  const iconSlotSvg = `
    <svg width="${iconSlotWidth}" height="${iconSlotHeight}" viewBox="0 0 ${iconSlotWidth} ${iconSlotHeight}" xmlns="http://www.w3.org/2000/svg">
      <!-- Badge Circular Frame -->
      <circle cx="160" cy="160" r="148" fill="#f5f3ff" stroke="#8b5cf6" stroke-width="6"/>
      <!-- Golden Dog Paw Print -->
      <path d="M160 155 C128 155 102 187 112 225 C118 248 141 257 160 257 C179 257 202 248 208 225 C218 187 192 155 160 155 Z" fill="#8b5cf6" />
      <ellipse cx="90" cy="142" rx="22" ry="32" fill="#8b5cf6" transform="rotate(-20 90 142)" />
      <ellipse cx="134" cy="110" rx="22" ry="32" fill="#8b5cf6" transform="rotate(-8 134 110)" />
      <ellipse cx="186" cy="110" rx="22" ry="32" fill="#8b5cf6" transform="rotate(8 186 110)" />
      <ellipse cx="230" cy="142" rx="22" ry="32" fill="#8b5cf6" transform="rotate(20 230 142)" />
    </svg>
  `;
  const iconSlotPixels = await createPixelDataFromSvg(iconSlotSvg, iconSlotWidth, iconSlotHeight);

  // 5. [text] Customer_Name (Text Banner preview: 700x120 at x:450, y:1600)
  const textWidth = 700;
  const textHeight = 120;
  const textX = 450;
  const textY = 1600;

  const textSvg = `
    <svg width="${textWidth}" height="${textHeight}" viewBox="0 0 ${textWidth} ${textHeight}" xmlns="http://www.w3.org/2000/svg">
      <text x="350" y="80" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="64" fill="#1e293b" text-anchor="middle">
        Jessica &amp; Max
      </text>
    </svg>
  `;
  const textPixels = await createPixelDataFromSvg(textSvg, textWidth, textHeight);

  // Build the Photoshop PSD Tree Structure
  const psd = {
    width: canvasWidth,
    height: canvasHeight,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3, // RGB
    children: [
      // 1. [fixed] Background Layer
      {
        name: '[fixed] Background Frame',
        top: 0,
        left: 0,
        bottom: canvasHeight,
        right: canvasWidth,
        imageData: bgPixels,
        hidden: false,
      },

      // 2. [group:skin] Mau_Da Group
      {
        name: '[group:skin] Mau_Da',
        opened: true,
        children: [
          {
            name: 'fair',
            top: skinY,
            left: skinX,
            bottom: skinY + skinHeight,
            right: skinX + skinWidth,
            imageData: skinFairPixels,
            hidden: false, // Default visible
          },
          {
            name: 'medium',
            top: skinY,
            left: skinX,
            bottom: skinY + skinHeight,
            right: skinX + skinWidth,
            imageData: skinMediumPixels,
            hidden: true,
          },
          {
            name: 'dark',
            top: skinY,
            left: skinX,
            bottom: skinY + skinHeight,
            right: skinX + skinWidth,
            imageData: skinDarkPixels,
            hidden: true,
          },
        ],
      },

      // 3. [group:hair] Kieu_Toc Group
      {
        name: '[group:hair] Kieu_Toc',
        opened: true,
        children: [
          {
            name: 'bob_brown',
            top: hairY,
            left: hairX,
            bottom: hairY + hairHeight,
            right: hairX + hairWidth,
            imageData: hairBobBrown,
            hidden: false, // Default visible
          },
          {
            name: 'bob_blonde',
            top: hairY,
            left: hairX,
            bottom: hairY + hairHeight,
            right: hairX + hairWidth,
            imageData: hairBobBlonde,
            hidden: true,
          },
          {
            name: 'curly_black',
            top: hairY,
            left: hairX,
            bottom: hairY + hairHeight,
            right: hairX + hairWidth,
            imageData: hairCurlyBlack,
            hidden: true,
          },
        ],
      },

      // 4. [slot:icon] Pet_Icon Layer
      {
        name: '[slot:icon] Pet_Icon',
        top: iconSlotY,
        left: iconSlotX,
        bottom: iconSlotY + iconSlotHeight,
        right: iconSlotX + iconSlotWidth,
        imageData: iconSlotPixels,
        hidden: false,
      },

      // 5. [text] Customer_Name Layer (Real Text layer + pixel rendering)
      {
        name: '[text] Customer_Name',
        top: textY,
        left: textX,
        bottom: textY + textHeight,
        right: textX + textWidth,
        imageData: textPixels,
        text: {
          text: 'Jessica & Max',
          style: {
            font: { name: 'Montserrat' },
            fontSize: 64,
            fillColor: { r: 30, g: 41, b: 59 },
          },
        },
        hidden: false,
      },
    ],
  };

  console.log('Encoding Photoshop PSD binary buffer...');
  const psdBuffer = writePsd(psd, {
    generateThumbnail: false,
    trim: false,
  });

  const outputDir = path.resolve(__dirname, '../../storage/sample-psd');
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'sample_portrait_template.psd');
  fs.writeFileSync(outputPath, Buffer.from(psdBuffer));

  const stats = fs.statSync(outputPath);
  console.log(`✅ Successfully generated sample PSD!`);
  console.log(`📁 File: ${outputPath}`);
  console.log(`📦 Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB (${stats.size} bytes)`);

  return outputPath;
}

generateSamplePsd().catch(err => {
  console.error('Error generating sample PSD:', err);
  process.exit(1);
});
