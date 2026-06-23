const Joi = require('joi');

const schemas = {
  login: Joi.object({
    username: Joi.string().required().messages({
      'any.required': 'Username/Email is required',
      'string.empty': 'Username/Email cannot be empty'
    }),
    password: Joi.string().required().messages({
      'any.required': 'Password is required',
      'string.empty': 'Password cannot be empty'
    })
  }),
  signup: Joi.object({
    username: Joi.string().pattern(/^[a-zA-Z0-9_]{3,20}$/).required().messages({
      'any.required': 'Username is required',
      'string.pattern.base': 'Username must be 3-20 characters long and can contain only letters, numbers, and underscores'
    }),
    email: Joi.string().email().required().messages({
      'any.required': 'Email is required',
      'string.email': 'Please enter a valid email address'
    }),
    password: Joi.string().min(8).required().messages({
      'any.required': 'Password is required',
      'string.min': 'Password must be at least 8 characters long'
    }),
    password_again: Joi.string().valid(Joi.ref('password')).required().messages({
      'any.required': 'Password confirmation is required',
      'any.only': 'Passwords do not match'
    }),
    name: Joi.string().allow(''),
    telephone: Joi.string().allow(''),
    whatsapp: Joi.string().allow(''),
    telegram: Joi.string().allow(''),
    website: Joi.string().allow(''),
    terms: Joi.any()
  }),
  googleLogin: Joi.object({
    credential: Joi.string().required().messages({
      'any.required': 'Google credential token is required'
    })
  }),
  resetPassword: Joi.object({
    email: Joi.string().email().required().messages({
      'any.required': 'Email is required',
      'string.email': 'Please enter a valid email address'
    })
  }),
  createOrder: Joi.object({
    service_id: Joi.number().integer().positive().required().messages({
      'any.required': 'Service ID is required',
      'number.base': 'Service ID must be a number'
    }),
    link: Joi.string().required().messages({
      'any.required': 'Link is required'
    }),
    quantity: Joi.number().integer().positive().required().messages({
      'any.required': 'Quantity is required',
      'number.base': 'Quantity must be a number'
    })
  }),
  refill: Joi.object({
    order_id: Joi.number().integer().positive().required().messages({
      'any.required': 'Order ID is required'
    })
  }),
  addFunds: Joi.object({
    method_id: Joi.number().integer().positive().required().messages({
      'any.required': 'Payment method ID is required'
    }),
    amount: Joi.number().positive().required().messages({
      'any.required': 'Amount is required'
    }),
    transaction_id: Joi.string().required().messages({
      'any.required': 'Transaction ID/reference is required'
    })
  }),
  initiatePayment: Joi.object({
    method_id: Joi.number().integer().positive().required().messages({
      'any.required': 'Payment method ID is required'
    }),
    amount: Joi.number().positive().required().messages({
      'any.required': 'Amount is required'
    })
  }),
  verifyPayment: Joi.object({
    method_id: Joi.number().integer().positive().required().messages({
      'any.required': 'Payment method ID is required'
    }),
    amount: Joi.number().positive().required().messages({
      'any.required': 'Amount is required'
    }),
    transaction_id: Joi.string().required().messages({
      'any.required': 'Transaction ID/reference is required'
    })
  }),
  updateProfile: Joi.object({
    name: Joi.string().allow(''),
    password: Joi.string().min(8).allow(''),
    profile_picture_url: Joi.string().allow(''),
    profile_picture_base64: Joi.string().allow(''),
    profile_picture_name: Joi.string().allow(''),
    // Reject read-only fields
    email: Joi.any().forbidden().messages({
      'any.unknown': 'Modifying email address is strictly forbidden for security reasons'
    }),
    username: Joi.any().forbidden().messages({
      'any.unknown': 'Modifying username is strictly forbidden for security reasons'
    }),
    telephone: Joi.any().forbidden().messages({
      'any.unknown': 'Modifying phone number is strictly forbidden for security reasons'
    })
  }),
  createTicket: Joi.object({
    subject: Joi.string().allow(''),
    subject_id: Joi.number().integer().min(1).optional(),
    extra_field: Joi.string().allow('').default(''),
    message: Joi.string().required().messages({
      'any.required': 'Message is required'
    })
  }).or('subject', 'subject_id').messages({
    'object.missing': 'Subject is required'
  }),
  replyTicket: Joi.object({
    message: Joi.string().required().messages({
      'any.required': 'Message is required'
    })
  }),
  submitBugReport: Joi.object({
    category: Joi.string().valid('report_bug', 'suggestion', 'other').default('report_bug'),
    message: Joi.string().required().messages({
      'any.required': 'Description is required'
    }),
    email: Joi.string().email().required().messages({
      'any.required': 'Email is required',
      'string.email': 'A valid email address is required'
    }),
    images: Joi.array().items(Joi.string()).max(5).default([])
  }),
  changeCurrency: Joi.object({
    currency_code: Joi.string().min(2).max(10),
    rate_key: Joi.string().min(2).max(10),
  }).or('currency_code', 'rate_key').messages({
    'object.missing': 'Currency code is required'
  })
};

function validateRequest(schemaName) {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) return next();

    const dataToValidate = req.method === 'GET' ? req.query : req.body;
    const { error } = schema.validate(dataToValidate, {
      abortEarly: true, // Stop validation on first error to return clean response messages
      allowUnknown: true
    });

    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }
    next();
  };
}

module.exports = {
  validateRequest
};
