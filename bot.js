const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const ZXing = require('node-zxing')();
const axios = require('axios');
const FormData = require('form-data');


// Cargar la configuración desde config.json
const config = JSON.parse(fs.readFileSync('./config/config.json', 'utf8'));

// Cargar las credenciales de la cuenta de servicio desde google-credentials.json
const credentials = JSON.parse(fs.readFileSync('./config/google-credentials.json', 'utf8'));

const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });

// Configuración del bot de Telegram
const bot = new TelegramBot(config.telegramToken, { polling: true });

// Variables para almacenar el estado de la conversación
let userState = {};
let productInfo = {};

// Función para verificar si el usuario está autorizado
function isUserAuthorized(userId) {
    return config.authorizedUsers.includes(userId);
}

// Función para realizar OCR usando OCRSpace
async function extractExpirationDate(imagePath) {
    const apiKey = config.OCRSpace; // Reemplaza con tu API Key de OCRSpace

    const formData = new FormData();
    formData.append('apikey', apiKey);
    formData.append('file', fs.createReadStream(imagePath));
    formData.append('language', 'spa');
    formData.append('OCREngine', '2');

    try {
        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders()  // Ahora debería funcionar correctamente
        });

        const text = response.data.ParsedResults[0].ParsedText;

        // Expresión regular para buscar fechas en formato DD/MM/YYYY, DD-MM-YYYY, MM/YYYY o MM-YYYY
        const dateRegex = /(\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4}|\d{2}\/\d{4}|\d{2}-\d{4})/g;
        const matches = text.match(dateRegex);

        if (matches) {
            let detectedDate = matches[0];

            // Si se detecta un formato MM/YYYY, ajustamos a DD/MM/YYYY con día 01
            if (/^\d{2}\/\d{4}$|^\d{2}-\d{4}$/.test(detectedDate)) {
                detectedDate = `01/${detectedDate.replace('-', '/')}`;
            }

            return detectedDate; // Devuelve la fecha ajustada
        } else {
            return null; // No se encontró una fecha
        }
    } catch (error) {
        console.error('Error al realizar OCR en la imagen:', error);
        return null;
    }
}

// Manejador para el comando de inicio
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    // Verificar si el usuario está autorizado
    if (!isUserAuthorized(msg.from.id)) {
        bot.sendMessage(chatId, "Lo siento, no tienes permiso para usar este bot.");
        return;
    }

    // Crear botones
    const options = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Añadir Manualmente', callback_data: 'manual_entry' },
                    { text: 'Añadir con Fotos', callback_data: 'photo_entry' }
                ]
            ]
        }
    };

    // Enviar mensaje con los botones
    bot.sendMessage(chatId, "¿Cómo te gustaría añadir el producto?", options);
});

// Manejador para los botones
bot.on('callback_query', (callbackQuery) => {
    const message = callbackQuery.message;
    const chatId = message.chat.id;

    // Verificar si el usuario está autorizado
    if (!isUserAuthorized(callbackQuery.from.id)) {
        bot.sendMessage(chatId, "Lo siento, no tienes permiso para usar este bot.");
        return;
    }

    if (callbackQuery.data === 'manual_entry') {
        bot.sendMessage(chatId, 'Por favor, ingresa el nombre del producto:');
        userState[chatId] = 'waitingForProductNameManual';
    } else if (callbackQuery.data === 'photo_entry') {
        bot.sendMessage(chatId, 'Por favor, envíame una imagen con el código de barras del producto.');
        userState[chatId] = 'waitingForBarcode';
    }
});

// Manejador para recibir imágenes
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const userCurrentState = userState[chatId];

    try {
        const fileLink = await bot.getFileLink(fileId);
        const filePath = path.join(__dirname, 'temp', `${fileId}.jpg`);

        // Descargar la imagen
        const response = await axios({
            url: fileLink,
            responseType: 'stream',
        });

        await new Promise((resolve, reject) => {
            const stream = fs.createWriteStream(filePath);
            response.data.pipe(stream);
            stream.on('finish', resolve);
            stream.on('error', reject);
        });

        if (userCurrentState === 'waitingForBarcode') {
            // Procesar la imagen para leer el código de barras
            ZXing.decode(filePath, async function(err, result) {
                if (err || !result) {
                    bot.sendMessage(chatId, 'No se pudo leer el código de barras. Por favor, ingresa el nombre del producto manualmente.');
                    userState[chatId] = 'waitingForProductNameManual';
                } else {
                    productInfo[chatId] = await getProductInfo(result);
                    if (productInfo[chatId]) {
                        bot.sendMessage(chatId, `Producto detectado: ${productInfo[chatId].name} (${productInfo[chatId].brand}), cantidad: ${productInfo[chatId].quantity}.`);
                        bot.sendMessage(chatId, 'Por favor, envía una imagen de la fecha de caducidad.');
                        userState[chatId] = 'waitingForExpirationDate';
                    } else {
                        bot.sendMessage(chatId, 'No se encontró información para este código de barras. Por favor, ingresa el nombre del producto manualmente.');
                        userState[chatId] = 'waitingForProductNameManual';
                    }
                }
                fs.unlinkSync(filePath); // Eliminar la imagen temporal
            });
        } else if (userCurrentState === 'waitingForExpirationDate') {
            // Procesar la imagen para leer la fecha de caducidad
            const expirationDate = await extractExpirationDate(filePath);
            if (expirationDate) {
                bot.sendMessage(chatId, `Fecha de caducidad detectada: ${expirationDate}. Creando evento en el calendario...`);
                createCalendarEvent(chatId, expirationDate);
            } else {
                bot.sendMessage(chatId, 'No se pudo leer la fecha de caducidad. Por favor, ingrésala manualmente en el formato DD/MM/YYYY o MM/YYYY.');
                userState[chatId] = 'waitingForExpirationDateManual';
            }
            fs.unlinkSync(filePath); // Eliminar la imagen temporal
        }
    } catch (err) {
        bot.sendMessage(chatId, 'Hubo un error al procesar la imagen.');
        console.error(err);
    }
});

// Manejador para recibir texto (nombre del producto y fecha)
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userCurrentState = userState[chatId];

    if (userCurrentState === 'waitingForProductNameManual') {
        productInfo[chatId] = { name: msg.text };
        bot.sendMessage(chatId, 'Producto registrado. Por favor, ingresa la fecha de caducidad en el formato MM/YYYY o DD/MM/YYYY:');
        userState[chatId] = 'waitingForExpirationDateManual';
    } else if (userCurrentState === 'waitingForExpirationDateManual') {
        const expirationDate = extractManualExpirationDate(msg.text);
        if (!expirationDate) {
            bot.sendMessage(chatId, 'La fecha ingresada no es válida. Asegúrate de usar el formato MM/YYYY o DD/MM/YYYY.');
        } else {
            bot.sendMessage(chatId, `Fecha de caducidad registrada: ${expirationDate}. Creando evento en el calendario...`);
            createCalendarEvent(chatId, expirationDate);
        }
    }
});

// Función para obtener información del producto desde Open Food Facts
async function getProductInfo(barcode) {
    try {
        const response = await axios.get(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`);
        if (response.data.status === 1) {
            const product = response.data.product;
            return {
                name: product.product_name,
                brand: product.brands,
                quantity: product.quantity,
            };
        } else {
            return null;  // Producto no encontrado
        }
    } catch (error) {
        console.error('Error al obtener la información del producto:', error);
        return null;
    }
}

// Función para crear un evento en Google Calendar
function createCalendarEvent(chatId, expirationDate) {
    const fechaRecordatorio = parseDate(expirationDate);
    fechaRecordatorio.setDate(fechaRecordatorio.getDate() - 2);

    const event = {
        summary: `${productInfo[chatId].name}`,
        start: { dateTime: fechaRecordatorio.toISOString(), timeZone: 'Europe/Madrid' },
        end: { dateTime: fechaRecordatorio.toISOString(), timeZone: 'Europe/Madrid' },
    };

    calendar.events.insert({
        calendarId: config.calendarId,
        resource: event,
    }, (err, event) => {
        if (err) {
            bot.sendMessage(chatId, 'Hubo un error al crear el recordatorio en el calendario.');
            console.error(err);
            return;
        }
        bot.sendMessage(chatId, `Recordatorio para consumir ${productInfo[chatId].name} creado para el ${fechaRecordatorio.toDateString()}.`);
        console.log(`Evento creado: ${event.data.htmlLink}`);
        // Limpiar el estado después de la creación del evento
        delete userState[chatId];
        delete productInfo[chatId];
    });
}

// Función para convertir una fecha en formato DD/MM/YYYY a un objeto Date
function parseDate(fecha) {
    const [dia, mes, año] = fecha.split('/').map(Number);
    return new Date(año, mes - 1, dia);
}

// Función para manejar la entrada manual de la fecha de caducidad
function extractManualExpirationDate(text) {
    // Expresión regular para DD/MM/YYYY o MM/YYYY
    const dateRegex = /^(?:\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{4})$/;
    const matches = text.match(dateRegex);

    if (matches) {
        let detectedDate = matches[0];

        // Si se detecta un formato MM/YYYY, ajustamos a DD/MM/YYYY con día 01
        if (/^\d{2}\/\d{4}$/.test(detectedDate)) {
            detectedDate = `01/${detectedDate}`;
        }

        return detectedDate; // Devuelve la fecha ajustada
    } else {
        return null; // Fecha no válida
    }
}
