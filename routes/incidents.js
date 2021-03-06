const express = require("express");
const { Client } = require("@googlemaps/google-maps-services-js");
const Nexmo = require("nexmo");

const auth = require("../middleware/auth");
const schema = require("../joi-schemas/incident");
const createResponse = require("./helpers/create-response");
const controller = require("../controllers/incidents");
const videoShareController = require("../controllers/video-shares");
const userController = require("../controllers/users");
const isClientError = require("../util/is-client-error");
const sendSms = require("./helpers/send-sms");
const signUrl = require("./helpers/sign-url");
const verifyRequest = require("./helpers/verify-request");
const sendVideo = require("../middleware/send-video");
const { INCIDENT_TYPES } = require("../util/constants");

const mapsClient = new Client();

const router = express.Router();

router.get("/:userId", auth, async function (req, res, next) {
  if (res.locals.userId !== req.params.userId) {
    return res.status(401).json(
      createResponse({
        error: "unauthorized access",
      })
    );
  }

  try {
    res.json(
      createResponse({
        data: await controller.getUserIncidents(req.params.userId),
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get("/video/token", auth, async (req, res, next) => {
  try {
    res.json(
      createResponse({
        data: signUrl(res.locals.userId),
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get("/video/shares/:userId", auth, async (req, res, next) => {
  if (res.locals.userId !== req.params.userId) {
    return res.status(401).json(
      createResponse({
        error: "Unauthorized access.",
      })
    );
  }

  try {
    res.json(
      createResponse({
        data: await videoShareController.findByUser(res.locals.userId),
      })
    );
  } catch (error) {
    next(error);
  }
});

router.post("/video/shares/:incidentId", auth, async (req, res, next) => {
  if (!req.body.shareTo) {
    return res.status(400).json(
      createResponse({
        error: "'shareTo' is required.",
      })
    );
  }

  try {
    const incident = await controller.findById(req.params.incidentId);
    if (String(incident.user) !== res.locals.userId) {
      return res.status(401).json(
        createResponse({
          error: "Unauthorized operation.",
        })
      );
    }

    res.status(201).json(
      createResponse({
        data: await videoShareController.create({
          ...req.body,
          incident: incident._id,
          user: res.locals.userId,
        }),
      })
    );
  } catch (error) {
    if (isClientError(error)) {
      return res.status(400).json(
        createResponse({
          error: error.message,
        })
      );
    }

    next(error);
  }
});

router.get(
  "/video/:filename",
  async function (req, res, next) {
    const { token } = req.query;
    let userId;

    if (!token) {
      return res.sendStatus(403);
    }

    try {
      userId = verifyRequest(token).userId;
      res.locals.userId = userId;
      next();
    } catch (error) {
      res.sendStatus(403);
    }
  },
  sendVideo
);

router.post("/", auth, async function (req, res, next) {
  try {
    await schema.newSchema.validateAsync(req.body);
  } catch (error) {
    return res.status(400).json(
      createResponse({
        error: error.message,
      })
    );
  }

  if (res.locals.userId !== req.body.user) {
    return res.status(401).json(
      createResponse({
        error: "Unauthorized operation.",
      })
    );
  }

  try {
    req.body.location.name = await getLocationName(req.body.location);

    const { contact } = req.body;
    const user = await userController.findById(req.body.user);
    if (!user) {
      return res.json(
        createResponse({
          error: "Operation allowed for app users only.",
        })
      );
    }

    await sendSms({
      recipient: contact.displayName,
      recipientPhone: contact.phone,
      sender: user.fullName,
      senderPhone: user.phone,
      locationName: req.body.location.name,
      latlng: {
        lat: req.body.location.latitude,
        lng: req.body.location.longitude,
      },
    })
      .then(async (response) => {
        const incident = await controller.create({
          ...req.body,
          sendSuccess: true,
          type: INCIDENT_TYPES.SMS,
        });

        res.status(201).json(
          createResponse({
            data: {
              ...response,
              ...incident.toObject(),
            },
          })
        );
      })
      .catch(async (error) => {
        console.log("SMS error", error);
        const incident = await controller.create({
          ...req.body,
          sendSuccess: false,
          type: INCIDENT_TYPES.SMS,
        });

        return res.json(
          createResponse({
            data: incident,
          })
        );
      });
  } catch (error) {
    if (isClientError(error)) {
      return res.status(400).json(
        createResponse({
          error: error.message,
        })
      );
    }

    next(error);
  }
});

router.delete("/video/:incidentId", auth, async function (req, res, next) {
  const incident = await controller.findById(req.params.incidentId);

  if (String(incident.user) !== res.locals.userId) {
    return res.status(403).json(
      createResponse({
        error: "Unauthorized operation.",
      })
    );
  }

  try {
    res.json(
      createResponse({
        data: await controller.deleteVideoFile(incident),
      })
    );
  } catch (error) {
    next(error);
  }
});

module.exports = router;

async function getLocationName(location) {
  const { data } = await mapsClient.reverseGeocode({
    params: {
      latlng: location,
      key: process.env.GOOGLE_MAPS_API_KEY,
    },
  });

  return data.results[0].formatted_address;
}
