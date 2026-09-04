import { Pool, types } from 'pg';

// Keep timestamp values as strings for consistent API responses.
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

const JSON_COLUMNS = new Map([
  ['guild_configs', new Set(['panels'])],
  ['tickets', new Set(['exam_state'])],
  ['guild_logs', new Set(['metadata'])],
  ['premium_purchases', new Set(['metadata'])],
  ['guild_backups', new Set(['summary', 'snapshot'])],
  ['guild_backup_restores', new Set(['summary'])]
]);

export function createPostgresClient(connectionString, {
  max = 5,
  connectionTimeoutMillis = 8_000,
  idleTimeoutMillis = 30_000
} = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required.');

  const { sanitizedConnectionString, ssl } = normalizeConnectionString(connectionString);
  const pool = new Pool({
    connectionString: sanitizedConnectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    keepAlive: true,
    ssl
  });

  pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error:', error?.message ?? error);
  });

  return new PostgresClient(pool);
}

class PostgresClient {
  constructor(pool) {
    this.pool = pool;
  }

  from(table) {
    return new PostgresQuery(this.pool, table);
  }

  async query(text, values = []) {
    return this.pool.query(text, values);
  }

  async withTransaction(callback) {
    const connection = await this.pool.connect();
    const transaction = {
      query: (text, values = []) => connection.query(text, values),
      from: (table) => new PostgresQuery(connection, table)
    };

    try {
      await connection.query('BEGIN');
      const result = await callback(transaction);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('PostgreSQL rollback failed:', rollbackError?.message ?? rollbackError);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class PostgresQuery {
  constructor(pool, table) {
    this.pool = pool;
    this.table = assertIdentifier(table, 'table');
    this.operation = 'select';
    this.payload = null;
    this.upsertConflict = [];
    this.selectedColumns = '*';
    this.returningRequested = false;
    this.filters = [];
    this.orFilters = [];
    this.orders = [];
    this.rowLimit = null;
    this.singleMode = null;
    this.countMode = null;
    this.head = false;
    this.executed = null;
  }

  select(columns = '*', options = {}) {
    this.selectedColumns = normalizeColumnList(columns);
    this.returningRequested = this.operation !== 'select';
    this.countMode = options?.count ?? null;
    this.head = Boolean(options?.head);
    return this;
  }

  insert(value) {
    this.operation = 'insert';
    this.payload = normalizeRows(value);
    return this;
  }

  upsert(value, { onConflict = '' } = {}) {
    this.operation = 'upsert';
    this.payload = normalizeRows(value);
    this.upsertConflict = String(onConflict)
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean)
      .map((column) => assertIdentifier(column, 'conflict column'));
    if (!this.upsertConflict.length) {
      throw new Error('PostgreSQL upsert requires onConflict.');
    }
    return this;
  }

  update(value) {
    this.operation = 'update';
    this.payload = normalizeObject(value);
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column: assertIdentifier(column, 'column'), value });
    return this;
  }

  in(column, values) {
    this.filters.push({
      type: 'in',
      column: assertIdentifier(column, 'column'),
      values: Array.isArray(values) ? values : []
    });
    return this;
  }

  or(expression) {
    const conditions = String(expression ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(parseOrCondition);
    if (conditions.length) this.orFilters.push(conditions);
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.orders.push({ column: assertIdentifier(column, 'column'), ascending: Boolean(ascending) });
    return this;
  }

  limit(value) {
    const limit = Number.parseInt(value, 10);
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid query limit: ${value}`);
    this.rowLimit = limit;
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  then(onFulfilled, onRejected) {
    return this.execute().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.execute().catch(onRejected);
  }

  finally(onFinally) {
    return this.execute().finally(onFinally);
  }

  execute() {
    if (!this.executed) this.executed = this.#executeOnce();
    return this.executed;
  }

  async #executeOnce() {
    try {
      const { text, values, returnsRows, countOnly } = this.#build();
      const result = await this.pool.query(text, values);
      const count = countOnly
        ? Number(result.rows[0]?.count ?? 0)
        : (this.countMode === 'exact' ? result.rowCount : null);

      let data = returnsRows ? result.rows : null;
      if (this.head) data = null;

      if (!this.head && this.singleMode === 'single') {
        if (result.rows.length !== 1) {
          return failure(new Error(`Expected exactly one row, received ${result.rows.length}.`));
        }
        data = result.rows[0];
      } else if (!this.head && this.singleMode === 'maybeSingle') {
        if (result.rows.length > 1) {
          return failure(new Error(`Expected zero or one row, received ${result.rows.length}.`));
        }
        data = result.rows[0] ?? null;
      }

      return {
        data,
        error: null,
        count,
        status: 200,
        statusText: 'OK'
      };
    } catch (error) {
      return failure(error);
    }
  }

  #build() {
    switch (this.operation) {
      case 'select':
        return this.#buildSelect();
      case 'insert':
        return this.#buildInsert(false);
      case 'upsert':
        return this.#buildInsert(true);
      case 'update':
        return this.#buildUpdate();
      case 'delete':
        return this.#buildDelete();
      default:
        throw new Error(`Unsupported PostgreSQL operation: ${this.operation}`);
    }
  }

  #buildSelect() {
    const values = [];
    const where = this.#buildWhere(values);
    const countOnly = this.head && this.countMode === 'exact';
    const columns = countOnly ? 'count(*)::INT AS count' : this.selectedColumns;
    let text = `SELECT ${columns} FROM ${quoteIdentifier(this.table)}${where}`;
    text += this.#buildOrder();
    text += this.#buildLimit(values);
    return { text, values, returnsRows: true, countOnly };
  }

  #buildInsert(upsert) {
    const rows = this.payload;
    if (!rows.length) throw new Error('Cannot insert an empty row set.');

    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].map((column) => assertIdentifier(column, 'column'));
    if (!columns.length) throw new Error('Cannot insert a row without columns.');

    const values = [];
    const tuples = rows.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(prepareValue(this.table, column, row[column]));
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    let text = `INSERT INTO ${quoteIdentifier(this.table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${tuples.join(', ')}`;

    if (upsert) {
      const updateColumns = columns.filter((column) => !this.upsertConflict.includes(column));
      if (updateColumns.length) {
        text += ` ON CONFLICT (${this.upsertConflict.map(quoteIdentifier).join(', ')}) DO UPDATE SET `;
        text += updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ');
      } else {
        text += ` ON CONFLICT (${this.upsertConflict.map(quoteIdentifier).join(', ')}) DO NOTHING`;
      }
    }

    const returnsRows = this.returningRequested || this.singleMode !== null;
    if (returnsRows) text += ` RETURNING ${this.selectedColumns}`;
    return { text, values, returnsRows, countOnly: false };
  }

  #buildUpdate() {
    const columns = Object.keys(this.payload).map((column) => assertIdentifier(column, 'column'));
    if (!columns.length) throw new Error('Cannot update without values.');

    const values = [];
    const assignments = columns.map((column) => {
      values.push(prepareValue(this.table, column, this.payload[column]));
      return `${quoteIdentifier(column)} = $${values.length}`;
    });
    const where = this.#buildWhere(values);
    if (!where) throw new Error('Refusing to update without a filter.');

    let text = `UPDATE ${quoteIdentifier(this.table)} SET ${assignments.join(', ')}${where}`;
    const returnsRows = this.returningRequested || this.singleMode !== null;
    if (returnsRows) text += ` RETURNING ${this.selectedColumns}`;
    return { text, values, returnsRows, countOnly: false };
  }

  #buildDelete() {
    const values = [];
    const where = this.#buildWhere(values);
    if (!where) throw new Error('Refusing to delete without a filter.');

    let text = `DELETE FROM ${quoteIdentifier(this.table)}${where}`;
    const returnsRows = this.returningRequested || this.singleMode !== null;
    if (returnsRows) text += ` RETURNING ${this.selectedColumns}`;
    return { text, values, returnsRows, countOnly: false };
  }

  #buildWhere(values) {
    const clauses = [];

    for (const filter of this.filters) {
      if (filter.type === 'eq') {
        if (filter.value === null) {
          clauses.push(`${quoteIdentifier(filter.column)} IS NULL`);
        } else {
          values.push(prepareValue(this.table, filter.column, filter.value));
          clauses.push(`${quoteIdentifier(filter.column)} = $${values.length}`);
        }
      } else if (filter.type === 'in') {
        if (!filter.values.length) {
          clauses.push('FALSE');
        } else {
          const placeholders = filter.values.map((value) => {
            values.push(prepareValue(this.table, filter.column, value));
            return `$${values.length}`;
          });
          clauses.push(`${quoteIdentifier(filter.column)} IN (${placeholders.join(', ')})`);
        }
      }
    }

    for (const group of this.orFilters) {
      const groupClauses = group.map((filter) => {
        if (filter.operator !== 'eq') throw new Error(`Unsupported OR operator: ${filter.operator}`);
        if (filter.value === null) return `${quoteIdentifier(filter.column)} IS NULL`;
        values.push(prepareValue(this.table, filter.column, filter.value));
        return `${quoteIdentifier(filter.column)} = $${values.length}`;
      });
      if (groupClauses.length) clauses.push(`(${groupClauses.join(' OR ')})`);
    }

    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  }

  #buildOrder() {
    if (!this.orders.length) return '';
    return ` ORDER BY ${this.orders
      .map(({ column, ascending }) => `${quoteIdentifier(column)} ${ascending ? 'ASC' : 'DESC'}`)
      .join(', ')}`;
  }

  #buildLimit(values) {
    if (this.rowLimit === null) return '';
    values.push(this.rowLimit);
    return ` LIMIT $${values.length}`;
  }
}

function normalizeConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must start with postgresql:// or postgres://.');
  }

  const sslMode = (url.searchParams.get('sslmode') ?? 'verify-full').toLowerCase();
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');

  const ssl = sslMode === 'disable'
    ? false
    : { rejectUnauthorized: !['require', 'prefer', 'allow'].includes(sslMode) };

  return {
    sanitizedConnectionString: url.toString(),
    ssl
  };
}

function normalizeRows(value) {
  const rows = Array.isArray(value) ? value : [value];
  return rows.map(normalizeObject);
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Database row values must be plain objects.');
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function normalizeColumnList(value) {
  const text = String(value ?? '*').trim();
  if (!text || text === '*') return '*';
  return text
    .split(',')
    .map((column) => quoteIdentifier(assertIdentifier(column.trim(), 'selected column')))
    .join(', ');
}

function parseOrCondition(value) {
  const firstDot = value.indexOf('.');
  const secondDot = value.indexOf('.', firstDot + 1);
  if (firstDot <= 0 || secondDot <= firstDot) throw new Error(`Invalid OR filter: ${value}`);
  const column = assertIdentifier(value.slice(0, firstDot), 'column');
  const operator = value.slice(firstDot + 1, secondDot);
  const rawValue = value.slice(secondDot + 1);
  return {
    column,
    operator,
    value: rawValue === 'null' ? null : rawValue
  };
}

function prepareValue(table, column, value) {
  if (value === undefined) return null;
  if (JSON_COLUMNS.get(table)?.has(column) && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

function assertIdentifier(value, label) {
  const text = String(value ?? '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text)) {
    throw new Error(`Invalid ${label}: ${text}`);
  }
  return text;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function failure(error) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (error?.code) normalized.code = error.code;
  if (error?.detail) normalized.details = error.detail;
  if (error?.hint) normalized.hint = error.hint;
  return {
    data: null,
    error: normalized,
    count: null,
    status: 500,
    statusText: 'Database Error'
  };
}
