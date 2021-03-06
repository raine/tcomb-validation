'use strict';

var t = require('tcomb');
var stringify = t.stringify;

var ValidationError = t.struct({
  message: t.Str,
  actual: t.Any,
  expected: t.Any,
  path: t.list(t.union([t.Str, t.Num]))
}, 'ValidationError');

function getDefaultValidationErrorMessage(actual, expected, path) {
  var expectedName = t.getTypeName(expected);
  var to = path.length ? '/' + path.join('/') + ': ' + expectedName : expectedName;
  return 'Invalid value ' + stringify(actual) + ' supplied to ' + to;
}

function getValidationErrorMessage(actual, expected, path, context) {
  if (t.Function.is(expected.getValidationErrorMessage)) {
    return expected.getValidationErrorMessage(actual, path, context);
  }
  else {
    return getDefaultValidationErrorMessage(actual, expected, path);
  }
}

ValidationError.of = function (actual, expected, path, context) {
  return new ValidationError({
    message: getValidationErrorMessage(actual, expected, path, context),
    actual: actual,
    expected: expected,
    path: path
  });
};

var ValidationResult = t.struct({
  errors: t.list(ValidationError),
  value: t.Any
}, 'ValidationResult');

ValidationResult.prototype.isValid = function () {
  return !(this.errors.length);
};

ValidationResult.prototype.firstError = function () {
  return this.isValid() ? null : this.errors[0];
};

ValidationResult.prototype.toString = function () {
  if (this.isValid()) {
    return '[ValidationResult, true, ' + stringify(this.value) + ']';
  }
  else {
    return '[ValidationResult, false, (' + this.errors.map(function (err) {
      return err.message;
    }).join(', ') + ')]';
  }
};

function validate(x, type, options) {
  options = options || {};
  var path = t.Array.is(options) ? options : options.path || [];
  return new ValidationResult(recurse(x, type, path, options.context));
}

function recurse(x, type, path, context) {
  if (t.isType(type)) {
    return validators[type.meta.kind](x, type, path, context);
  }
  else {
    return validators.es6classes(x, type, path, context);
  }
}

var validators = validate.validators = {};

validators.es6classes = function validateES6Classes(x, type, path, context) {
  return {
    value: x,
    errors: x instanceof type ? [] : [ValidationError.of(x, type, path, context)]
  };
};

// irreducibles and enums
validators.irreducible =
validators.enums = function validateIrreducible(x, type, path, context) {
  return {
    value: x,
    errors: type.is(x) ? [] : [ValidationError.of(x, type, path, context)]
  };
};

validators.list = function validateList(x, type, path, context) {

  // x should be an array
  if (!t.Arr.is(x)) {
    return {value: x, errors: [ValidationError.of(x, type, path, context)]};
  }

  var ret = {value: [], errors: []};
  // every item should be of type `type.meta.type`
  for (var i = 0, len = x.length; i < len; i++ ) {
    var item = recurse(x[i], type.meta.type, path.concat(i), context);
    ret.value[i] = item.value;
    ret.errors = ret.errors.concat(item.errors);
  }
  return ret;
};

validators.subtype = function validateSubtype(x, type, path, context) {

  // x should be a valid inner type
  var ret = recurse(x, type.meta.type, path, context);
  if (ret.errors.length) {
    return ret;
  }

  // x should satisfy the predicate
  if (!type.meta.predicate(ret.value)) {
    ret.errors = [ValidationError.of(x, type, path, context)];
  }

  return ret;

};

validators.maybe = function validateMaybe(x, type, path, context) {
  return t.Nil.is(x) ?
    {value: null, errors: []} :
    recurse(x, type.meta.type, path, context);
};

validators.struct = function validateStruct(x, type, path, context) {

  // x should be an object
  if (!t.Obj.is(x)) {
    return {value: x, errors: [ValidationError.of(x, type, path, context)]};
  }

  // [optimization]
  if (type.is(x)) {
    return {value: x, errors: []};
  }

  var ret = {value: {}, errors: []};
  var props = type.meta.props;
  // every item should be of type `props[name]`
  for (var name in props) {
    if (props.hasOwnProperty(name)) {
      var prop = recurse(x[name], props[name], path.concat(name), context);
      ret.value[name] = prop.value;
      ret.errors = ret.errors.concat(prop.errors);
    }
  }
  if (!ret.errors.length) {
    ret.value = new type(ret.value);
  }
  return ret;
};

validators.tuple = function validateTuple(x, type, path, context) {

  var types = type.meta.types;
  var len = types.length;

  // x should be an array of at most `len` items
  if (!t.Arr.is(x) || x.length > len) {
    return {value: x, errors: [ValidationError.of(x, type, path, context)]};
  }

  var ret = {value: [], errors: []};
  // every item should be of type `types[i]`
  for (var i = 0; i < len; i++) {
    var item = recurse(x[i], types[i], path.concat(i), context);
    ret.value[i] = item.value;
    ret.errors = ret.errors.concat(item.errors);
  }
  return ret;
};

validators.dict = function validateDict(x, type, path, context) {

  // x should be an object
  if (!t.Obj.is(x)) {
    return {value: x, errors: [ValidationError.of(x, type, path, context)]};
  }

  var ret = {value: {}, errors: []};
  // every key should be of type `domain`
  // every value should be of type `codomain`
  for (var k in x) {
    if (x.hasOwnProperty(k)) {
      var subpath = path.concat(k);
      var key = recurse(k, type.meta.domain, subpath, context);
      var item = recurse(x[k], type.meta.codomain, subpath, context);
      ret.value[k] = item.value;
      ret.errors = ret.errors.concat(key.errors, item.errors);
    }
  }
  return ret;
};

validators.union = function validateUnion(x, type, path, context) {
  var ctor = type.dispatch(x);
  return t.Func.is(ctor) ?
    recurse(x, ctor, path.concat(type.meta.types.indexOf(ctor)), context) :
    {value: x, errors: [ValidationError.of(x, type, path, context)]};
};

validators.intersection = function validateIntersection(x, type, path, context) {

  var types = type.meta.types;
  var len = types.length;

  var ret = {value: x, errors: []};
  // x should be of type `types[i]` for all i
  for (var i = 0; i < len; i++) {
    var item = recurse(x, types[i], path, context);
    ret.errors = ret.errors.concat(item.errors);
  }
  return ret;
};

t.mixin(t, {
  ValidationError: ValidationError,
  ValidationResult: ValidationResult,
  validate: validate
});

module.exports = t;
