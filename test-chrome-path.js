import puppeteer from 'puppeteer';
import fs from 'fs';

console.log('Executable Path:', puppeteer.executablePath());
console.log('Exists:', fs.existsSync(puppeteer.executablePath()));
console.log('Exists chromium:', fs.existsSync('/usr/bin/chromium'));