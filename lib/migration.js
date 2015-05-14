var async = require('async');
module.exports = mixinMigration;

function mixinMigration(PostgreSQL) {

  /*!
   * Discover the properties from a table
   * @param {String} model The model name
   * @param {Function} cb The callback function
   */
  PostgreSQL.prototype.getTableStatus = function(model, cb) {
    var fields;
    var indexes;

    function done (err) {
      if (fields && indexes) {
        cb(err, fields, indexes);
      }
    }

    function decoratedTableDataCallback(err, data) {
      if (err) {
        console.error(err);
      }
      if (!err) {
        data.forEach(function(field) {
          field.type = mapPostgreSQLDatatypes(field.type);
        });
      }
      fields = data;
      done(err);
    }

    function decoratedIndexDataCallback(err, data) {
      var indexHash = {};

      if (err) {
        console.log(err);
      }

      indexes = data;
      done(err);
    }

    this.query('SELECT column_name AS "column", data_type AS "type", ' +
               'is_nullable AS "nullable"' // , data_default AS "Default"'
    + ' FROM "information_schema"."columns" WHERE table_name=\'' +
      this.table(model) + '\'', decoratedTableDataCallback);

    this.query(
      'SELECT t.relname AS "table", i.relname AS "name", ' +
        'am.amname AS "type", ix.indisprimary AS "primary", ' +
        'ix.indisunique AS "unique", ' +
        'ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) ' +
        '  FROM generate_subscripts(ix.indkey, 1) AS k ' +
        '  ORDER BY k ) AS "keys", ' +
        'ARRAY(SELECT ' +
        '  CASE ix.indoption[k] & 1 WHEN 1 THEN \'DESC\' ELSE \'ASC\' END ' +
        '  FROM generate_subscripts(ix.indoption, 1) AS k ' +
        '  ORDER BY k ' +
        ') AS "order" ' +
        'FROM pg_class t, pg_class i, pg_index ix, pg_am am ' +
        'WHERE t.oid = ix.indrelid AND i.oid = ix.indexrelid AND ' +
        'i.relam = am.oid AND ' +
        't.relkind=\'r\' AND t.relname=\'' +
        this.table(model) + '\'', decoratedIndexDataCallback);
  }
  /**
   * Perform autoupdate for the given models
   * @param {String[]} [models] A model name or an array of model names. If not present, apply to all models
   * @callback {Function} [callback] The callback function
   * @param {String|Error} err The error string or object
   */
  PostgreSQL.prototype.autoupdate = function(models, cb) {
    var self = this;
    if ((!cb) && ('function' === typeof models)) {
      cb = models;
      models = undefined;
    }
    // First argument is a model name
    if ('string' === typeof models) {
      models = [models];
    }

    models = models || Object.keys(this._models);

    async.each(models, function(model, done) {
      if (!(model in self._models)) {
        return process.nextTick(function() {
          done(new Error('Model not found: ' + model));
        });
      }
      getTableStatus.call(self, model, function(err, fields, indexes) {
        if (!err && fields.length) {
          self.alterTable(model, fields, indexes, done);
        } else {
          self.createTable(model, done);
        }
      });
    }, cb);
  };

  /*!
   * Check if the models exist
   * @param {String[]} [models] A model name or an array of model names. If not present, apply to all models
   * @param {Function} [cb] The callback function
   */
  PostgreSQL.prototype.isActual = function(models, cb) {
    var self = this;

    if ((!cb) && ('function' === typeof models)) {
      cb = models;
      models = undefined;
    }
    // First argument is a model name
    if ('string' === typeof models) {
      models = [models];
    }

    models = models || Object.keys(this._models);

    // TODO perform checks on indexes

    var changes = [];
    async.each(models, function(model, done) {
      getTableStatus.call(self, model, function(err, fields) {
        changes = changes.concat(getAddModifyColumns.call(self, model, fields));
        changes = changes.concat(getDropColumns.call(self, model, fields));
        done(err);
      });
    }, function done(err) {
      if (err) {
        return cb && cb(err);
      }
      var actual = (changes.length === 0);
      cb && cb(null, actual);
    });
  };

  /*!
   * Alter the table for the given model
   * @param {String} model The model name
   * @param {Object[]} actualFields Actual columns in the table
   * @param {Object[]} actualIndexes Actual indexes in the table
   * @param {Function} [cb] The callback function
   */
  PostgreSQL.prototype.alterTable = function(model, actualFields, actualIndexes, cb) {
    var self = this;
    var m = this._models[model];
    var propNames = Object.keys(m.properties).filter(function(name) {
      return !!m.properties;
    });
    var indexNames = m.settings.indexes ? Object.keys(m.settings.indexes).filter(function(name) {
      return !!m.settings.indexes[name];
    }) : [];

    var applyPending = function(actions, cb, err, result) {
      var action = actions.shift();
      var pendingChanges = action && action.call(self, model, actualFields) || [];
      if (pendingChanges.length) {
        applySqlChanges.call(self, model, pendingChanges, function(err, result) {
          if (!err) {
            applyPending(actions, cb, err, result);
          } else {
            cb(err, result);
          }
        });
      } else if (actions.length) {
        applyPending(actions, cb); // We still have actions to apply
      } else {
        cb(err, result); // All finished
      }
    }

    async.series([
      function(cb) {
        applyPending([getAddModifyColumns, getDropColumns], cb);
      },
      function(cb) {
        self.addIndexes(model, actualIndexes, cb);
      }
    ], function(err, result) {
      cb(err, result[0]);
    });
  };

  PostgreSQL.prototype.getAddModifyColumns = function(model, actualFields) {
    var sql = [];
    var self = this;
    sql = sql.concat(getColumnsToAdd.call(self, model, actualFields));
    var drops = getPropertiesToModify.call(self, model, actualFields);
    if (drops.length > 0) {
      if (sql.length > 0) {
        sql = sql.concat(', ');
      }
      sql = sql.concat(drops);
    }
    // sql = sql.concat(getColumnsToDrop.call(self, model, actualFields));
    return sql;
  };

  PostgreSQL.prototype.getDropColumns = function(model, actualFields) {
    var sql = [];
    var self = this;
    sql = sql.concat(getColumnsToDrop.call(self, model, actualFields));
    return sql;
  };

  PostgreSQL.prototype.getColumnsToAdd = function(model, actualFields) {
    var self = this;
    var m = self._models[model];
    var propNames = Object.keys(m.properties);
    var sql = [];
    propNames.forEach(function(propName) {
      if (self.id(model, propName)) return;
      var found = searchForPropertyInActual.call(self, model, self.column(model, propName), actualFields);
      if (!found && propertyHasNotBeenDeleted.call(self, model, propName)) {
        sql.push('ADD COLUMN ' + addPropertyToActual.call(self, model, propName));
      }
    });
    if (sql.length > 0) {
      sql = [sql.join(', ')];
    }
    return sql;
  };

  PostgreSQL.prototype.addPropertyToActual = function(model, propName) {
    var self = this;
    var sqlCommand = self.columnEscaped(model, propName)
    + ' ' + self.columnDataType(model, propName) + (propertyCanBeNull.call(self, model, propName) ? '' : ' NOT NULL');
    return sqlCommand;
  };

  PostgreSQL.prototype.searchForPropertyInActual = function(model, propName, actualFields) {
    var self = this;
    var found = false;
    actualFields.forEach(function(f) {
      if (f.column === self.column(model, propName)) {
        found = f;
        return;
      }
    });
    return found;
  };

  PostgreSQL.prototype.getPropertiesToModify = function(model, actualFields) {
    var self = this;
    var sql = [];
    var m = self._models[model];
    var propNames = Object.keys(m.properties);
    var found;
    propNames.forEach(function(propName) {
      if (self.id(model, propName)) {
        return;
      }
      found = searchForPropertyInActual.call(self, model, propName, actualFields);
      if (found && propertyHasNotBeenDeleted.call(self, model, propName)) {
        if (datatypeChanged(propName, found)) {
          sql.push('ALTER COLUMN ' + modifyDatatypeInActual.call(self, model, propName));
        }
        if (nullabilityChanged(propName, found)) {
          sql.push('ALTER COLUMN' + modifyNullabilityInActual.call(self, model, propName));
        }
      }
    });

    if (sql.length > 0) {
      sql = [sql.join(', ')];
    }

    return sql;

    function datatypeChanged(propName, oldSettings) {
      var newSettings = m.properties[propName];
      if (!newSettings) {
        return false;
      }
      return oldSettings.type.toUpperCase() !== self.columnDataType(model, propName);
    }

    function isNullable(p) {
      return !(p.required ||
               p.id ||
               p.allowNull === false ||
               p.null === false ||
               p.nullable === false);
    }

    function nullabilityChanged(propName, oldSettings) {
      var newSettings = m.properties[propName];
      if (!newSettings) {
        return false;
      }
      var changed = false;
      if (oldSettings.nullable === 'YES' && !isNullable(newSettings)) {
        changed = true;
      }
      if (oldSettings.nullable === 'NO' && isNullable(newSettings)) {
        changed = true;
      }
      return changed;
    }
  };

  PostgreSQL.prototype.modifyDatatypeInActual = function(model, propName) {
    var self = this;
    var sqlCommand = self.columnEscaped(model, propName) + ' TYPE ' +
      self.columnDataType(model, propName);
    return sqlCommand;
  };

  PostgreSQL.prototype.modifyNullabilityInActual = function(model, propName) {
    var self = this;
    var sqlCommand = self.columnEscaped(model, propName) + ' ';
    if (propertyCanBeNull.call(self, model, propName)) {
      sqlCommand = sqlCommand + "DROP ";
    } else {
      sqlCommand = sqlCommand + "SET ";
    }
    sqlCommand = sqlCommand + "NOT NULL";
    return sqlCommand;
  };

  PostgreSQL.prototype.getColumnsToDrop = function(model, actualFields) {
    var self = this;
    var sql = [];
    actualFields.forEach(function(actualField) {
      if (self.idColumn(model) === actualField.column) {
        return;
      }
      if (actualFieldNotPresentInModel(actualField, model)) {
        sql.push('DROP COLUMN ' + self.escapeName(actualField.column));
      }
    });
    if (sql.length > 0) {
      sql = [sql.join(', ')];
    }
    return sql;

    function actualFieldNotPresentInModel(actualField, model) {
      return !(self.propertyName(model, actualField.column));
    }
  };

  PostgreSQL.prototype.applySqlChanges = function(model, pendingChanges, cb) {
    var self = this;
    if (pendingChanges.length) {
      var thisQuery = 'ALTER TABLE ' + self.tableEscaped(model);
      var ranOnce = false;
      pendingChanges.forEach(function(change) {
        if (ranOnce) {
          thisQuery = thisQuery + ' ';
        }
        thisQuery = thisQuery + ' ' + change;
        ranOnce = true;
      });
      // thisQuery = thisQuery + ';';
      self.query(thisQuery, cb);
    }
  };

  /*!
   * Create a table for the given model
   * @param {String} model The model name
   * @param {Function} [cb] The callback function
   */
  PostgreSQL.prototype.createTable = function(model, cb) {
    var self = this;
    var name = self.tableEscaped(model);

    // Please note IF NOT EXISTS is introduced in postgresql v9.3
    self.query('CREATE SCHEMA ' +
      self.escapeName(self.schemaName(model)),
      function(err) {
        if (err && err.code !== '42P06') {
          return cb && cb(err);
        }
        self.query('CREATE TABLE ' + name + ' (\n  ' +
          self.propertiesSQL(model) + '\n)',
          function(err, info) {
            if (err) {
              cb(err, info);
            }
            self.addIndexes(model, undefined, cb);
          }
        );
      });
  };


  /*!
   * Get the database-default value for column from given model property
   *
   * @param {String} model The model name
   * @param {String} property The property name
   * @returns {String} The column default value
   */
  PostgreSQL.prototype.columnDbDefault = function(model, property) {
    var columnMetadata = this.columnMetadata(model, property);
    var colDefault = columnMetadata && columnMetadata.dbDefault;

    return colDefault ? (' DEFAULT ' + columnMetadata.dbDefault) : '';
  }

  /*!
   * Find the column type for a given model property
   *
   * @param {String} model The model name
   * @param {String} property The property name
   * @returns {String} The column type
   */
  PostgreSQL.prototype.columnDataType = function(model, property) {
    var columnMetadata = this.columnMetadata(model, property);
    var colType = columnMetadata && columnMetadata.dataType;
    if (colType) {
      colType = colType.toUpperCase();
    }
    var prop = this._models[model].properties[property];
    if (!prop) {
      return null;
    }
    var colLength = columnMetadata && columnMetadata.dataLength || prop.length;
    if (colType) {
      return colType + (colLength ? '(' + colLength + ')' : '');
    }

    switch (prop.type.name) {
      default:
        case 'String':
        case 'JSON':
        return 'VARCHAR' + (colLength ? '(' + colLength + ')' : '(1024)');
      case 'Text':
        return 'VARCHAR' + (colLength ? '(' + colLength + ')' : '(1024)');
      case 'Number':
        return 'INTEGER';
      case 'Date':
        return 'TIMESTAMP WITH TIME ZONE';
      case 'Timestamp':
        return 'TIMESTAMP WITH TIME ZONE';
      case 'GeoPoint':
        case 'Point':
        return 'POINT';
      case 'Boolean':
        return 'BOOLEAN'; // PostgreSQL doesn't have built-in boolean
    }
  };


  /*!
   * Map postgresql data types to json types
   * @param {String} postgresqlType
   * @param {Number} dataLength
   * @returns {String}
   */
  function postgresqlDataTypeToJSONType(postgresqlType, dataLength) {
    var type = postgresqlType.toUpperCase();
    switch (type) {
      case 'BOOLEAN':
        return 'Boolean';

      /*
       - character varying(n), varchar(n)	variable-length with limit
       - character(n), char(n)	fixed-length, blank padded
       - text	variable unlimited length
       */
      case 'VARCHAR':
        case 'CHARACTER VARYING':
        case 'CHARACTER':
        case 'CHAR':
        case 'TEXT':
        return 'String';

      case 'BYTEA':
        return 'Binary';
      /*
       - smallint	2 bytes	small-range integer	-32768 to +32767
       - integer	4 bytes	typical choice for integer	-2147483648 to +2147483647
       - bigint	8 bytes	large-range integer	-9223372036854775808 to 9223372036854775807
       - decimal	variable	user-specified precision, exact	no limit
       - numeric	variable	user-specified precision, exact	no limit
       - real	4 bytes	variable-precision, inexact	6 decimal digits precision
       - double precision	8 bytes	variable-precision, inexact	15 decimal digits precision
       - serial	4 bytes	autoincrementing integer	1 to 2147483647
       - bigserial	8 bytes	large autoincrementing integer	1 to 9223372036854775807
       */
      case 'SMALLINT':
        case 'INTEGER':
        case 'BIGINT':
        case 'DECIMAL':
        case 'NUMERIC':
        case 'REAL':
        case 'DOUBLE':
        case 'SERIAL':
        case 'BIGSERIAL':
        return 'Number';

      /*
       - timestamp [ (p) ] [ without time zone ]	8 bytes	both date and time (no time zone)	4713 BC	294276 AD	1 microsecond / 14 digits
       - timestamp [ (p) ] with time zone	8 bytes	both date and time, with time zone	4713 BC	294276 AD	1 microsecond / 14 digits
       - date	4 bytes	date (no time of day)	4713 BC	5874897 AD	1 day
       - time [ (p) ] [ without time zone ]	8 bytes	time of day (no date)	00:00:00	24:00:00	1 microsecond / 14 digits
       - time [ (p) ] with time zone	12 bytes	times of day only, with time zone	00:00:00+1459	24:00:00-1459	1 microsecond / 14 digits
       - interval [ fields ] [ (p) ]	12 bytes	time interval	-178000000 years	178000000 years	1 microsecond / 14 digits
       */
      case 'DATE':
        case 'TIMESTAMP':
        case 'TIME':
        case 'TIME WITH TIME ZONE':
        case 'TIME WITHOUT TIME ZONE':
        case 'TIMESTAMP WITH TIME ZONE':
        case 'TIMESTAMP WITHOUT TIME ZONE':
        return 'Date';

      case 'POINT':
        return 'GeoPoint';

      default:
        return 'String';
    }
  };

  function mapPostgreSQLDatatypes(typeName) {
    return typeName;
  }

  function propertyHasNotBeenDeleted(model, propName) {
    return !!this._models[model].properties[propName];
  }
};
