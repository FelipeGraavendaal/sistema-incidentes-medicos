const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pacientes (
        id SERIAL PRIMARY KEY,
        rut_completo VARCHAR(12) UNIQUE NOT NULL,
        rut_ultimos_3 CHAR(3) NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        apellido VARCHAR(100),
        iniciales CHAR(2) NOT NULL,
        email VARCHAR(150),
        telefono VARCHAR(20),
        nivel_riesgo VARCHAR(10) DEFAULT 'BAJO',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS incidentes (
        id SERIAL PRIMARY KEY,
        paciente_id INTEGER REFERENCES pacientes(id) ON DELETE CASCADE,
        tipo_incidente VARCHAR(100) NOT NULL,
        descripcion TEXT NOT NULL,
        fecha_incidente DATE NOT NULL,
        nivel_gravedad VARCHAR(10) NOT NULL,
        centro_medico VARCHAR(200),
        numero_registro VARCHAR(50) UNIQUE,
        created_by_email VARCHAR(150),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS centros_medicos (
        id SERIAL PRIMARY KEY,
        email VARCHAR(150) UNIQUE NOT NULL,
        nombre_centro VARCHAR(200) NOT NULL,
        rut_centro VARCHAR(12),
        telefono VARCHAR(20),
        direccion TEXT,
        plan_id VARCHAR(50),
        suscripcion_activa BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS suscripciones (
        id SERIAL PRIMARY KEY,
        centro_id INTEGER REFERENCES centros_medicos(id),
        commerce_order VARCHAR(100) UNIQUE NOT NULL,
        plan_id VARCHAR(50) NOT NULL,
        email VARCHAR(150) NOT NULL,
        monto INTEGER NOT NULL,
        estado VARCHAR(20) DEFAULT 'pendiente',
        fecha_inicio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        fecha_activacion TIMESTAMP,
        fecha_vencimiento TIMESTAMP,
        payment_token VARCHAR(200),
        payment_data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_busqueda ON pacientes(rut_ultimos_3, iniciales);
      CREATE INDEX IF NOT EXISTS idx_paciente_incidentes ON incidentes(paciente_id);
      CREATE INDEX IF NOT EXISTS idx_suscripciones_email ON suscripciones(email);
    `);
    
    console.log('✅ Base de datos inicializada');
  } catch (error) {
    console.error('❌ Error al inicializar BD:', error);
  }
}

initDB();

const PLANES = {
  basico: { nombre: 'Plan Básico', precio: 9990, duracion: 30, limite_registros: 50 },
  profesional: { nombre: 'Plan Profesional', precio: 19990, duracion: 30, limite_registros: -1 },
  empresa: { nombre: 'Plan Empresa', precio: 49990, duracion: 30, limite_registros: -1 }
};

async function verificarSuscripcion(req, res, next) {
  const email = req.headers['user-email'] || req.body.userEmail;

  if (!email) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const result = await pool.query(
      `SELECT s.*, c.plan_id FROM suscripciones s
       JOIN centros_medicos c ON s.centro_id = c.id
       WHERE s.email = $1 AND s.estado = 'activa' AND s.fecha_vencimiento > NOW()
       ORDER BY s.fecha_vencimiento DESC LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ 
        error: 'Suscripción inactiva',
        requiereSuscripcion: true
      });
    }

    req.suscripcion = result.rows[0];
    next();
  } catch (error) {
    res.status(500).json({ error: 'Error al verificar suscripción' });
  }
}

app.get('/api/planes', (req, res) => {
  res.json({ planes: PLANES });
});

app.post('/api/crear-suscripcion', async (req, res) => {
  const { planId, email, centroMedico, telefono, rutCentro } = req.body;
  
  if (!PLANES[planId] || !email || !centroMedico || !telefono) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const plan = PLANES[planId];
  const commerceOrder = `SUB-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    let centro = await pool.query('SELECT * FROM centros_medicos WHERE email = $1', [email]);

    let centroId;
    if (centro.rows.length === 0) {
      const nuevoCentro = await pool.query(
        `INSERT INTO centros_medicos (email, nombre_centro, telefono, rut_centro, plan_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [email, centroMedico, telefono, rutCentro, planId]
      );
      centroId = nuevoCentro.rows[0].id;
    } else {
      centroId = centro.rows[0].id;
    }

    await pool.query(
      `INSERT INTO suscripciones (centro_id, commerce_order, plan_id, email, monto, estado)
       VALUES ($1, $2, $3, $4, $5, 'pendiente')`,
      [centroId, commerceOrder, planId, email, plan.precio]
    );

    const paymentUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/simulacion-pago?order=${commerceOrder}`;

    res.json({
      success: true,
      paymentUrl: paymentUrl,
      orderId: commerceOrder
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al procesar suscripción' });
  }
});

app.post('/api/confirmar-pago', async (req, res) => {
  const { commerceOrder, paymentToken } = req.body;

  try {
    const suscripcion = await pool.query(
      `SELECT s.*, c.id as centro_id FROM suscripciones s
       JOIN centros_medicos c ON s.centro_id = c.id
       WHERE s.commerce_order = $1`,
      [commerceOrder]
    );

    if (suscripcion.rows.length === 0) {
      return res.status(404).json({ error: 'Suscripción no encontrada' });
    }

    const sub = suscripcion.rows[0];
    const fechaVencimiento = new Date();
    fechaVencimiento.setDate(fechaVencimiento.getDate() + 30);

    await pool.query(
      `UPDATE suscripciones SET estado = 'activa', fecha_activacion = NOW(),
       fecha_vencimiento = $1, payment_token = $2 WHERE commerce_order = $3`,
      [fechaVencimiento, paymentToken, commerceOrder]
    );

    await pool.query(
      `UPDATE centros_medicos SET suscripcion_activa = true, plan_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [sub.plan_id, sub.centro_id]
    );

    res.json({ success: true, numeroRegistro: commerceOrder });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al confirmar pago' });
  }
});

app.get('/api/verificar-suscripcion/:email', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, c.nombre_centro,
              EXTRACT(DAY FROM (s.fecha_vencimiento - NOW())) as dias_restantes
       FROM suscripciones s
       JOIN centros_medicos c ON s.centro_id = c.id
       WHERE s.email = $1 AND s.estado = 'activa' AND s.fecha_vencimiento > NOW()
       ORDER BY s.fecha_vencimiento DESC LIMIT 1`,
      [req.params.email]
    );

    if (result.rows.length > 0) {
      const sub = result.rows[0];
      res.json({
        activa: true,
        suscripcion: {
          plan: PLANES[sub.plan_id].nombre,
          fechaVencimiento: sub.fecha_vencimiento,
          diasRestantes: Math.floor(sub.dias_restantes),
          nombreCentro: sub.nombre_centro
        }
      });
    } else {
      res.json({ activa: false });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error' });
  }
});

app.post('/api/buscar-paciente', async (req, res) => {
  try {
    const { rut_ultimos_3, iniciales } = req.body;

    const result = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM incidentes WHERE paciente_id = p.id) as total_incidentes
       FROM pacientes p WHERE p.rut_ultimos_3 = $1 AND UPPER(p.iniciales) = UPPER($2)`,
      [rut_ultimos_3, iniciales]
    );

    if (result.rows.length === 0) {
      return res.json({ pacientes: [] });
    }

    const pacientes = await Promise.all(result.rows.map(async (paciente) => {
      const incidentes = await pool.query(
        `SELECT * FROM incidentes WHERE paciente_id = $1 ORDER BY fecha_incidente DESC`,
        [paciente.id]
      );
      
      return { ...paciente, estudios: incidentes.rows };
    }));

    res.json({ pacientes });
  } catch (error) {
    res.status(500).json({ error: 'Error al buscar' });
  }
});

app.post('/api/registrar-incidente', verificarSuscripcion, async (req, res) => {
  try {
    const { rutPaciente, nombre, apellido, tipoIncidente, descripcion, fechaIncidente, centroMedico, userEmail } = req.body;

    if (!rutPaciente || !nombre || !tipoIncidente || !descripcion || !fechaIncidente) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const rutLimpio = rutPaciente.replace(/\D/g, '');
    const rut_ultimos_3 = rutLimpio.slice(-4, -1);
    const iniciales = (nombre.charAt(0) + (apellido ? apellido.charAt(0) : 'X')).toUpperCase();

    let paciente = await pool.query('SELECT * FROM pacientes WHERE rut_completo = $1', [rutPaciente]);

    let pacienteId;
    if (paciente.rows.length === 0) {
      const nuevoPaciente = await pool.query(
        `INSERT INTO pacientes (rut_completo, rut_ultimos_3, nombre, apellido, iniciales, nivel_riesgo)
         VALUES ($1, $2, $3, $4, $5, 'BAJO') RETURNING id`,
        [rutPaciente, rut_ultimos_3, nombre, apellido, iniciales]
      );
      pacienteId = nuevoPaciente.rows[0].id;
    } else {
      pacienteId = paciente.rows[0].id;
    }

    const tiposAltos = ['agresion_fisica', 'amenazas'];
    const tiposMedios = ['agresion_verbal', 'comportamiento_agresivo', 'demanda_amenazada'];
    
    let nivelGravedad = 'BAJO';
    if (tiposAltos.includes(tipoIncidente)) nivelGravedad = 'ALTO';
    else if (tiposMedios.includes(tipoIncidente)) nivelGravedad = 'MEDIO';

    const numeroRegistro = `INC-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    await pool.query(
      `INSERT INTO incidentes (paciente_id, tipo_incidente, descripcion, fecha_incidente, nivel_gravedad, centro_medico, numero_registro, created_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [pacienteId, tipoIncidente, descripcion, fechaIncidente, nivelGravedad, centroMedico, numeroRegistro, userEmail]
    );

    const totalIncidentes = await pool.query(
      'SELECT COUNT(*) as total FROM incidentes WHERE paciente_id = $1',
      [pacienteId]
    );

    let nuevoNivelRiesgo = 'BAJO';
    const total = parseInt(totalIncidentes.rows[0].total);
    if (total >= 3) nuevoNivelRiesgo = 'ALTO';
    else if (total >= 2) nuevoNivelRiesgo = 'MEDIO';

    await pool.query(
      'UPDATE pacientes SET nivel_riesgo = $1, updated_at = NOW() WHERE id = $2',
      [nuevoNivelRiesgo, pacienteId]
    );

    res.json({ success: true, numeroRegistro });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

app.get('/simulacion-pago', (req, res) => {
  const order = req.query.order;
  res.send(`
    <html>
      <head>
        <title>Simulación de Pago</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-gray-100 min-h-screen flex items-center justify-center">
        <div class="bg-white rounded-lg shadow-xl p-8 max-w-md">
          <h1 class="text-2xl font-bold mb-4">Simulación de Pago</h1>
          <p class="text-gray-600 mb-4">Orden: ${order}</p>
          <p class="text-sm text-gray-500 mb-6">En producción sería Flow.cl</p>
          <button onclick="confirmarPago()" 
            class="w-full bg-green-600 text-white py-3 rounded-lg font-bold hover:bg-green-700">
            Confirmar Pago
          </button>
        </div>
        <script>
          function confirmarPago() {
            fetch('/api/confirmar-pago', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                commerceOrder: '${order}',
                paymentToken: 'SIM-' + Date.now()
              })
            })
            .then(r => r.json())
            .then(data => {
              if (data.success) {
                window.location.href = '/exito.html?order=${order}';
              }
            });
          }
        </script>
      </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en puerto ${port}`);
});
