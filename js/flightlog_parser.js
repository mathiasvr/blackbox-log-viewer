"use strict";

var FlightLogIndex;

var FlightLogParser = function(logData) {
    //Private constants:
    var
        FLIGHT_LOG_MAX_FIELDS = 128,
        FLIGHT_LOG_MAX_FRAME_LENGTH = 256,
        
        FIRMWARE_TYPE_UNKNOWN = 0,
        FIRMWARE_TYPE_BASEFLIGHT = 1,
        FIRMWARE_TYPE_CLEANFLIGHT = 2,
        
        //Assume that even in the most woeful logging situation, we won't miss 10 seconds of frames
        MAXIMUM_TIME_JUMP_BETWEEN_FRAMES = (10 * 1000000),

        //Likewise for iteration count
        MAXIMUM_ITERATION_JUMP_BETWEEN_FRAMES = (500 * 10),

        // Flight log field predictors:
        
        //No prediction:
        FLIGHT_LOG_FIELD_PREDICTOR_0              = 0,

        //Predict that the field is the same as last frame:
        FLIGHT_LOG_FIELD_PREDICTOR_PREVIOUS       = 1,

        //Predict that the slope between this field and the previous item is the same as that between the past two history items:
        FLIGHT_LOG_FIELD_PREDICTOR_STRAIGHT_LINE  = 2,

        //Predict that this field is the same as the average of the last two history items:
        FLIGHT_LOG_FIELD_PREDICTOR_AVERAGE_2      = 3,

        //Predict that this field is minthrottle
        FLIGHT_LOG_FIELD_PREDICTOR_MINTHROTTLE    = 4,

        //Predict that this field is the same as motor 0
        FLIGHT_LOG_FIELD_PREDICTOR_MOTOR_0        = 5,

        //This field always increments
        FLIGHT_LOG_FIELD_PREDICTOR_INC            = 6,

        //Predict this GPS co-ordinate is the GPS home co-ordinate (or no prediction if that coordinate is not set)
        FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD     = 7,

        //Predict 1500
        FLIGHT_LOG_FIELD_PREDICTOR_1500           = 8,

        //Predict vbatref, the reference ADC level stored in the header
        FLIGHT_LOG_FIELD_PREDICTOR_VBATREF        = 9,
        
        //Predict the last time value written in the main stream
        FLIGHT_LOG_FIELD_PREDICTOR_LAST_MAIN_FRAME_TIME = 10,

        //Home coord predictors appear in pairs (two copies of FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD). Rewrite the second
        //one we see to this to make parsing easier
        FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD_1   = 256,
        
        FLIGHT_LOG_FIELD_ENCODING_SIGNED_VB       = 0, // Signed variable-byte
        FLIGHT_LOG_FIELD_ENCODING_UNSIGNED_VB     = 1, // Unsigned variable-byte
        FLIGHT_LOG_FIELD_ENCODING_NEG_14BIT       = 3, // Unsigned variable-byte but we negate the value before storing, value is 14 bits
        FLIGHT_LOG_FIELD_ENCODING_TAG8_8SVB       = 6,
        FLIGHT_LOG_FIELD_ENCODING_TAG2_3S32       = 7,
        FLIGHT_LOG_FIELD_ENCODING_TAG8_4S16       = 8,
        FLIGHT_LOG_FIELD_ENCODING_NULL            = 9, // Nothing is written to the file, take value to be zero
        
        FLIGHT_LOG_EVENT_LOG_END = 255,
        
        EOF = ArrayDataStream.prototype.EOF,
        NEWLINE  = '\n'.charCodeAt(0);
    
    //Private variables:
    var
        that = this,
                
        //Information about fields which we need to decode them properly. Have "encoding" and "predictor" arrays.
        frameDefs = {},
        dataVersion,
        
        defaultSysConfig = {
            frameIntervalI: 32,
            frameIntervalPNum: 1,
            frameIntervalPDenom: 1,
            firmwareType: FIRMWARE_TYPE_UNKNOWN,
            rcRate: 90,
            vbatscale: 110,
            vbatref: 4095,
            vbatmincellvoltage: 33,
            vbatmaxcellvoltage:43,
            vbatwarningcellvoltage: 35,
            gyroScale: 0.0001, // Not even close to the default, but it's hardware specific so we can't do much better
            acc_1G: 4096, // Ditto ^
            minthrottle: 1150,
            maxthrottle: 1850,
            currentMeterOffset: 0,
            currentMeterScale: 400
        },
            
        frameTypes,
        
        // Blackbox state:
        mainHistoryRing,
        
        /* Points into blackboxHistoryRing to give us a circular buffer.
        *
        * 0 - space to decode new frames into, 1 - previous frame, 2 - previous previous frame
        *
        * Previous frame pointers are null when no valid history exists of that age.
        */
        mainHistory = [null, null, null],
        mainStreamIsValid = false,
        
        gpsHomeHistory = new Array(2), // 0 - space to decode new frames into, 1 - previous frame
        gpsHomeIsValid = false,

        //Because these events don't depend on previous events, we don't keep copies of the old state, just the current one:
        lastEvent,
        lastGPS,
    
        // How many intentionally un-logged frames did we skip over before we decoded the current frame?
        lastSkippedFrames,
        
        // Details about the last main frame that was successfully parsed
        lastMainFrameIteration,
        lastMainFrameTime,
        
        //The actual log data stream we're reading:
        stream;

    //Public fields:
    this.mainFieldNames = [];
    this.gpsFieldNames = [];
    this.gpsHomeFieldNames = [];
    
    this.mainFieldCount = 0;
    this.gpsFieldCount = 0;
    this.gpsHomeFieldCount = 0;
    
    this.mainFieldNameToIndex = {};
    this.gpsFieldNameToIndex = {};
    this.gpsHomeFieldNameToIndex = {};
    
    this.sysConfig = Object.create(defaultSysConfig);
    
    /* 
     * Event handler of the signature (frameValid, frame, frameType, frameOffset, frameSize)
     * called when a frame has been decoded.
     */
    this.onFrameReady = null;
    
    function mapFieldNamesToIndex(fieldNames) {
        var
            result = {};
        
        for (var i = 0; i < fieldNames.length; i++) {
            result[fieldNames[i]] = i;
        }

        return result;
    }
    
    function parseHeaderLine() {
        var 
            COLON = ":".charCodeAt(0),
        
            fieldName, fieldValue,
            lineStart, lineEnd, separatorPos = false,
            matches,
            i, c;
            
        if (stream.peekChar() != ' ')
            return;

        //Skip the leading space
        stream.readChar();

        lineStart = stream.pos;
        
        for (; stream.pos < lineStart + 1024 && stream.pos < stream.end; stream.pos++) {
            if (separatorPos === false && stream.data[stream.pos] == COLON)
                separatorPos = stream.pos;
            
            if (stream.data[stream.pos] == NEWLINE || stream.data[stream.pos] == 0)
                break;
        }

        if (stream.data[stream.pos] != NEWLINE || separatorPos === false)
            return;

        lineEnd = stream.pos;

        fieldName = asciiArrayToString(stream.data.subarray(lineStart, separatorPos));
        fieldValue = asciiArrayToString(stream.data.subarray(separatorPos + 1, lineEnd));

        switch (fieldName) {
            case "Field I name":
                that.mainFieldNames = fieldValue.split(",");
                that.mainFieldCount = that.mainFieldNames.length; 

                that.mainFieldNameToIndex = mapFieldNamesToIndex(that.mainFieldNames);
            break;
            case "Field G name":
                that.gpsFieldNames = fieldValue.split(",");
                that.gpsFieldCount = that.gpsFieldNames.length; 

                that.gpsFieldNameToIndex = mapFieldNamesToIndex(that.gpsFieldNames);
            break;
            case "Field H name":
                that.gpsHomeFieldNames = fieldValue.split(",");
                that.gpsHomeFieldCount = that.gpsHomeFieldNames.length; 

                that.gpsHomeFieldNameToIndex = mapFieldNamesToIndex(that.gpsHomeFieldNames);
            break;
            case "Field I signed":
                that.mainFieldSigned = parseCommaSeparatedIntegers(fieldValue);
            break;
            case "I interval":
                that.sysConfig.frameIntervalI = parseInt(fieldValue, 10);
                if (that.sysConfig.frameIntervalI < 1)
                    that.sysConfig.frameIntervalI = 1;
            break;
            case "P interval":
                var matches = fieldValue.match(/(\d+)\/(\d+)/);
                
                if (matches) {
                    that.sysConfig.frameIntervalPNum = parseInt(matches[1], 10);
                    that.sysConfig.frameIntervalPDenom = parseInt(matches[2], 10);
                }
            break;
            case "Data version":
                dataVersion = parseInt(fieldValue, 10);
            break;
            case "Firmware type":
                switch (fieldValue) {
                    case "Cleanflight":
                        that.sysConfig.firmwareType = FIRMWARE_TYPE_CLEANFLIGHT;
                    break;
                    default:
                        that.sysConfig.firmwareType = FIRMWARE_TYPE_BASEFLIGHT;
                }
            break;
            case "minthrottle":
                that.sysConfig.minthrottle = parseInt(fieldValue, 10);
            break;
            case "maxthrottle":
                that.sysConfig.maxthrottle = parseInt(fieldValue, 10);
            break;
            case "rcRate":
                that.sysConfig.rcRate = parseInt(fieldValue, 10);
            break;
            case "vbatscale":
                that.sysConfig.vbatscale = parseInt(fieldValue, 10);
            break;
            case "vbatref":
                that.sysConfig.vbatref = parseInt(fieldValue, 10);
            break;
            case "vbatcellvoltage":
                var vbatcellvoltageParams = parseCommaSeparatedIntegers(fieldValue);
    
                that.sysConfig.vbatmincellvoltage = vbatcellvoltageParams[0];
                that.sysConfig.vbatwarningcellvoltage = vbatcellvoltageParams[1];
                that.sysConfig.vbatmaxcellvoltage = vbatcellvoltageParams[2];
            break;
            case "currentMeter":
                var currentMeterParams = parseCommaSeparatedIntegers(fieldValue);
                
                that.sysConfig.currentMeterOffset = currentMeterParams[0];
                that.sysConfig.currentMeterScale = currentMeterParams[1];
            break;
            case "gyro.scale":
                that.sysConfig.gyroScale = hexToFloat(fieldValue);
        
                /* Baseflight uses a gyroScale that'll give radians per microsecond as output, whereas Cleanflight produces degrees
                 * per second and leaves the conversion to radians per us to the IMU. Let's just convert Cleanflight's scale to
                 * match Baseflight so we can use Baseflight's IMU for both: */
                if (that.sysConfig.firmwareType == FIRMWARE_TYPE_CLEANFLIGHT) {
                    that.sysConfig.gyroScale = that.sysConfig.gyroScale * (Math.PI / 180.0) * 0.000001;
                }
            break;
            case "acc_1G":
                that.sysConfig.acc_1G = parseInt(fieldValue, 10);
            break;
            default:
                if ((matches = fieldName.match(/^Field (.) predictor$/))) {
                    if (!frameDefs[matches[1]])
                        frameDefs[matches[1]] = {};
                    
                    frameDefs[matches[1]].predictor = parseCommaSeparatedIntegers(fieldValue);
                } else if ((matches = fieldName.match(/^Field (.) encoding$/))) {
                    if (!frameDefs[matches[1]])
                        frameDefs[matches[1]] = {};
                    
                    frameDefs[matches[1]].encoding = parseCommaSeparatedIntegers(fieldValue);
                }
            break;
        }
    }

    function invalidateMainStream() {
        mainStreamIsValid = false;
        
        mainHistory[0] = mainHistoryRing[0];
        mainHistory[1] = null;
        mainHistory[2] = null;
    }
    
    function updateFieldStatistics(fields) {
        var i;

        for (i = 0; i < that.mainFieldCount; i++) {
            if (!that.stats.field[i]) {
                that.stats.field[i] = {
                    max: fields[i],
                    min: fields[i]
                };
            } else {
                that.stats.field[i].max = fields[i] > that.stats.field[i].max ? fields[i] : that.stats.field[i].max;
                that.stats.field[i].min = fields[i] < that.stats.field[i].min ? fields[i] : that.stats.field[i].min;
            }
        }
    }

    function completeIntraframe(frameType, frameStart, frameEnd, raw) {
        var acceptFrame = true;

        // Do we have a previous frame to use as a reference to validate field values against?
        if (!raw && lastMainFrameIteration != -1) {
            /*
             * Check that iteration count and time both moved forward, and time didn't move forward too much.
             */
            acceptFrame =
                mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_ITERATION] > lastMainFrameIteration
                && mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_ITERATION] < lastMainFrameIteration + MAXIMUM_ITERATION_JUMP_BETWEEN_FRAMES
                && mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME] >= lastMainFrameTime
                && mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME] < lastMainFrameTime + MAXIMUM_TIME_JUMP_BETWEEN_FRAMES;
        }

        if (acceptFrame) {
            that.stats.intentionallyAbsentIterations += countIntentionallySkippedFramesTo(mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_ITERATION]);

            lastMainFrameIteration = mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_ITERATION];
            lastMainFrameTime = mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME];

            mainStreamIsValid = true;

            updateFieldStatistics(mainHistory[0]);
        } else {
            invalidateMainStream();
        }

        if (that.onFrameReady)
            that.onFrameReady(mainStreamIsValid, mainHistory[0], frameType, frameStart, frameEnd - frameStart);

        // Rotate history buffers

        // Both the previous and previous-previous states become the I-frame, because we can't look further into the past than the I-frame
        mainHistory[1] = mainHistory[0];
        mainHistory[2] = mainHistory[0];

        // And advance the current frame into an empty space ready to be filled
        if (mainHistory[0] == mainHistoryRing[0])
            mainHistory[0] = mainHistoryRing[1];
        else if (mainHistory[0] == mainHistoryRing[1])
            mainHistory[0] = mainHistoryRing[2];
        else
            mainHistory[0] = mainHistoryRing[0];
    }
    
    /**
     * Should a frame with the given index exist in this log (based on the user's selection of sampling rates)?
     */
    function shouldHaveFrame(frameIndex)
    {
        return (frameIndex % that.sysConfig.frameIntervalI + that.sysConfig.frameIntervalPNum - 1) 
            % that.sysConfig.frameIntervalPDenom < that.sysConfig.frameIntervalPNum;
    }
    
    /**
     * Attempt to parse the frame of the given `frameType` into the supplied `frame` buffer using the encoding/predictor
     * definitions from frameDefs[`frameType`].
     *
     * raw - Set to true to disable predictions (and so store raw values)
     * skippedFrames - Set to the number of field iterations that were skipped over by rate settings since the last frame.
     */
    function parseFrame(frameType, current, previous, previous2, fieldCount, skippedFrames, raw)
    {
        var
            predictor = frameDefs[frameType].predictor,
            encoding = frameDefs[frameType].encoding,
            values = new Array(8),
            i, j, groupCount;

        i = 0;
        while (i < fieldCount) {
            var
                value;

            if (predictor[i] == FLIGHT_LOG_FIELD_PREDICTOR_INC) {
                current[i] = skippedFrames + 1;

                if (previous)
                    current[i] += previous[i];

                i++;
            } else {
                switch (encoding[i]) {
                    case FLIGHT_LOG_FIELD_ENCODING_SIGNED_VB:
                        value = stream.readSignedVB();
                    break;
                    case FLIGHT_LOG_FIELD_ENCODING_UNSIGNED_VB:
                        value = stream.readUnsignedVB();
                    break;
                    case FLIGHT_LOG_FIELD_ENCODING_NEG_14BIT:
                        value = -signExtend14Bit(stream.readUnsignedVB());
                    break;
                    case FLIGHT_LOG_FIELD_ENCODING_TAG8_4S16:
                        if (dataVersion < 2)
                            stream.readTag8_4S16_v1(values);
                        else
                            stream.readTag8_4S16_v2(values);

                        //Apply the predictors for the fields:
                        for (j = 0; j < 4; j++, i++)
                            current[i] = applyPrediction(i, raw ? FLIGHT_LOG_FIELD_PREDICTOR_0 : predictor[i], values[j], current, previous, previous2);

                        continue;
                    break;
                    case FLIGHT_LOG_FIELD_ENCODING_TAG2_3S32:
                        stream.readTag2_3S32(values);

                        //Apply the predictors for the fields:
                        for (j = 0; j < 3; j++, i++)
                            current[i] = applyPrediction(i, raw ? FLIGHT_LOG_FIELD_PREDICTOR_0 : predictor[i], values[j], current, previous, previous2);

                        continue;
                    break;
                    case FLIGHT_LOG_FIELD_ENCODING_TAG8_8SVB:
                        //How many fields are in this encoded group? Check the subsequent field encodings:
                        for (j = i + 1; j < i + 8 && j < that.mainFieldCount; j++)
                            if (encoding[j] != FLIGHT_LOG_FIELD_ENCODING_TAG8_8SVB)
                                break;

                        groupCount = j - i;

                        stream.readTag8_8SVB(values, groupCount);

                        for (j = 0; j < groupCount; j++, i++)
                            current[i] = applyPrediction(i, raw ? FLIGHT_LOG_FIELD_PREDICTOR_0 : predictor[i], values[j], current, previous, previous2);

                        continue;
                    break;
                    case FLIGHT_LOG_FIELD_ENCODING_NULL:
                        //Nothing to read
                        value = 0;
                    break;
                    default:
                        throw "Unsupported field encoding " + encoding[i];
                }

                current[i] = applyPrediction(i, raw ? FLIGHT_LOG_FIELD_PREDICTOR_0 : predictor[i], value, current, previous, previous2);
                i++;
            }
        }
    }
    
    function parseIntraframe(raw) {
        var 
            current = mainHistory[0],
            previous = mainHistory[1];

        parseFrame('I', current, previous, null, that.mainFieldCount, 0, raw);
    }
    
    function completeGPSHomeFrame(frameType, frameStart, frameEnd, raw) {
        //Copy the decoded frame into the "last state" entry of gpsHomeHistory to publish it:
        for (var i = 0; i < that.gpsHomeFieldCount; i++) {
            gpsHomeHistory[1][i] = gpsHomeHistory[0][i];
        }
        
        gpsHomeIsValid = true;

        if (that.onFrameReady) {
            that.onFrameReady(true, gpsHomeHistory[1], frameType, frameStart, frameEnd - frameStart);
        }

        return true;
    }

    function completeGPSFrame(frameType, frameStart, frameEnd, raw) {
        if (that.onFrameReady) {
            that.onFrameReady(gpsHomeIsValid, lastGPS, frameType, frameStart, frameEnd - frameStart);
        }
        
        return true;
    }
    
    function completeInterframe(frameType, frameStart, frameEnd, raw) {
        // Reject this frame if the time or iteration count jumped too far
        if (mainStreamIsValid && !raw
                && (
                    mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME] > lastMainFrameTime + MAXIMUM_TIME_JUMP_BETWEEN_FRAMES
                    || mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_ITERATION] > lastMainFrameIteration + MAXIMUM_ITERATION_JUMP_BETWEEN_FRAMES
                )) {
            mainStreamIsValid = false;
        }
        
        if (mainStreamIsValid) {
            lastMainFrameIteration = mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_ITERATION];
            lastMainFrameTime = mainHistory[0][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME];

            that.stats.intentionallyAbsentIterations += lastSkippedFrames;

            updateFieldStatistics(mainHistory[0]);
        }
        
        //Receiving a P frame can't resynchronise the stream so it doesn't set mainStreamIsValid to true

        if (that.onFrameReady)
            that.onFrameReady(mainStreamIsValid, mainHistory[0], frameType, frameStart, frameEnd - frameStart);

        if (mainStreamIsValid) {
            // Rotate history buffers

            mainHistory[2] = mainHistory[1];
            mainHistory[1] = mainHistory[0];

            // And advance the current frame into an empty space ready to be filled
            if (mainHistory[0] == mainHistoryRing[0])
                mainHistory[0] = mainHistoryRing[1];
            else if (mainHistory[0] == mainHistoryRing[1])
                mainHistory[0] = mainHistoryRing[2];
            else
                mainHistory[0] = mainHistoryRing[0];
        }
    }
    
    /**
     * Take the raw value for a a field, apply the prediction that is configured for it, and return it.
     */
    function applyPrediction(fieldIndex, predictor, value, current, previous, previous2)
    {
        switch (predictor) {
            case FLIGHT_LOG_FIELD_PREDICTOR_0:
                // No correction to apply
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_MINTHROTTLE:
                value += that.sysConfig.minthrottle;
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_1500:
                value += 1500;
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_MOTOR_0:
                if (that.mainFieldNameToIndex["motor[0]"] < 0) {
                    throw "Attempted to base I-field prediction on motor0 before it was read";
                }
                value += current[that.mainFieldNameToIndex["motor[0]"]];
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_VBATREF:
                value += that.sysConfig.vbatref;
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_PREVIOUS:
                if (!previous)
                    break;

                value += previous[fieldIndex];
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_STRAIGHT_LINE:
                if (!previous)
                    break;

                value += 2 * previous[fieldIndex] - previous2[fieldIndex];
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_AVERAGE_2:
                if (!previous)
                    break;

                //Round toward zero like C would do for integer division:
                value += ~~((previous[fieldIndex] + previous2[fieldIndex]) / 2);
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD:
                if (that.gpsHomeFieldNameToIndex["GPS_home[0]"] === undefined) {
                    throw "Attempted to base prediction on GPS home position without GPS home frame definition";
                }

                value += gpsHomeHistory[1][that.gpsHomeFieldNameToIndex["GPS_home[0]"]];
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD_1:
                if (that.gpsHomeFieldNameToIndex["GPS_home[1]"] === undefined) {
                    throw "Attempted to base prediction on GPS home position without GPS home frame definition";
                }

                value += gpsHomeHistory[1][that.gpsHomeFieldNameToIndex["GPS_home[1]"]];
            break;
            case FLIGHT_LOG_FIELD_PREDICTOR_LAST_MAIN_FRAME_TIME:
                if (mainHistory[1])
                    value += mainHistory[1][FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME];
            break;
            default:
                throw "Unsupported field predictor " + predictor;
        }

        return value;
    }
    
    /*
     * Based on the log sampling rate, work out how many frames would have been skipped after the last frame that was
     * parsed until we get to the next logged iteration.
     */
    function countIntentionallySkippedFrames()
    {
        var 
            count = 0, frameIndex;

        if (lastMainFrameIteration == -1) {
            // Haven't parsed a frame yet so there's no frames to skip
            return 0;
        } else {
            for (frameIndex = lastMainFrameIteration + 1; !shouldHaveFrame(frameIndex); frameIndex++) {
                count++;
            }
        }

        return count;
    }
    
    /*
     * Based on the log sampling rate, work out how many frames would have been skipped after the last frame that was
     * parsed until we get to the iteration with the given index.
     */
    function countIntentionallySkippedFramesTo(targetIteration)
    {
        var
            count = 0, frameIndex;

        if (lastMainFrameIteration == -1) {
            // Haven't parsed a frame yet so there's no frames to skip
            return 0;
        } else {
            for (frameIndex = lastMainFrameIteration + 1; frameIndex < targetIteration; frameIndex++) {
                if (!shouldHaveFrame(frameIndex)) {
                    count++;
                }
            }
        }

        return count;
    }
    
    function parseInterframe(raw) {
        var
            current = mainHistory[0],
            previous = mainHistory[1],
            previous2 = mainHistory[2];

        lastSkippedFrames = countIntentionallySkippedFrames();

        parseFrame('P', current, previous, previous2, that.mainFieldCount, lastSkippedFrames, raw);
    }
    
    function parseGPSFrame(raw) {
        // Only parse a GPS frame if we have GPS header definitions
        if (that.gpsFieldCount > 0) {
            parseFrame('G', lastGPS, null, null, that.gpsFieldCount, 0, raw);
        }
    }

    function parseGPSHomeFrame(raw) {
        if (that.gpsHomeFieldCount > 0) {
            parseFrame('H', gpsHomeHistory[0], null, null, that.gpsHomeFieldCount, 0, raw);
        }
    }

    function completeEventFrame(frameType, frameStart, frameEnd, raw) {
        if (lastEvent) {
            if (that.onFrameReady) {
                that.onFrameReady(true, lastEvent, frameType, frameStart, frameEnd - frameStart);
            }
            
            return true;
        }
        
        return false;
    }
    
    function parseEventFrame(raw) {
        var 
            END_OF_LOG_MESSAGE = "End of log\0",
            
            eventType = stream.readByte();

        lastEvent = {
            event: eventType,
            data: {}
        };

        switch (eventType) {
            case FlightLogEvent.SYNC_BEEP:
                lastEvent.data.time = stream.readUnsignedVB();
                lastEvent.time = lastEvent.data.time;
            break;
            case FlightLogEvent.AUTOTUNE_CYCLE_START:
                lastEvent.data.phase = stream.readByte();
                
                var cycleAndRising = stream.readByte();
                
                lastEvent.data.cycle = cycleAndRising & 0x7F;
                lastEvent.data.rising = (cycleAndRising >> 7) & 0x01;
                
                lastEvent.data.p = stream.readByte();
                lastEvent.data.i = stream.readByte();
                lastEvent.data.d = stream.readByte();
            break;
            case FlightLogEvent.AUTOTUNE_CYCLE_RESULT:
                lastEvent.data.overshot = stream.readByte();
                lastEvent.data.p = stream.readByte();
                lastEvent.data.i = stream.readByte();
                lastEvent.data.d = stream.readByte();;
            break;
            case FlightLogEvent.AUTOTUNE_TARGETS:
                //Convert the angles from decidegrees back to plain old degrees for ease of use
                lastEvent.data.currentAngle = stream.readS16() / 10.0;
                
                lastEvent.data.targetAngle = stream.readS8();
                lastEvent.data.targetAngleAtPeak = stream.readS8();
                
                lastEvent.data.firstPeakAngle = stream.readS16() / 10.0;
                lastEvent.data.secondPeakAngle = stream.readS16() / 10.0;
            break;
            case FlightLogEvent.LOG_END:
                var endMessage = stream.readString(END_OF_LOG_MESSAGE.length);

                if (endMessage == END_OF_LOG_MESSAGE) {
                    //Adjust the end of stream so we stop reading, this log is done
                    stream.end = stream.pos;
                } else {
                    /*
                     * This isn't the real end of log message, it's probably just some bytes that happened to look like
                     * an event header.
                     */
                    lastEvent = null;
                }
            break;
            default:
                lastEvent = null;
        }
    }
    
    function getFrameType(command) {
        return frameTypes[command];
    }
    
    //Reset any parsed information from previous parses
    this.resetState = function() {
        this.resetStats();
        
        //Reset system configuration to MW's defaults
        this.sysConfig = Object.create(defaultSysConfig);
        
        this.mainFieldNames = [];
        this.gpsFieldNames = [];
        this.gpsHomeFieldNames = [];
        
        this.mainFieldCount = 0;
        this.gpsFieldCount = 0;
        this.gpsHomeFieldCount = 0;
        
        this.mainFieldNameToIndex = {};
        this.gpsFieldNameToIndex = {};
        this.gpsHomeFieldNameToIndex = {};
        
        lastSkippedFrames = 0;
        
        lastMainFrameIteration = -1;
        lastMainFrameTime = -1;
        
        mainStreamIsValid = false;
        gpsHomeIsValid = false;
    };
    
    this.parseHeader = function(startOffset, endOffset) {
        this.resetState();
        
        //Set parsing ranges up
        stream.start = startOffset === undefined ? stream.pos : startOffset;
        stream.pos = stream.start;
        stream.end = endOffset === undefined ? stream.end : endOffset;
        stream.eof = false;

        mainloop:
        while (true) {
            var command = stream.readChar();

            switch (command) {
                case "H":
                    parseHeaderLine();
                break;
                case EOF:
                    break mainloop;
                default:
                    /* 
                     * If we see something that looks like the beginning of a data frame, assume it
                     * is and terminate the header.
                     */
                    if (getFrameType(command)) {
                        stream.unreadChar(command);

                        break mainloop;
                    } // else skip garbage which apparently precedes the first data frame
                break;
            }
        }
        
        if (this.mainFieldCount == 0) {
            throw "Data file is missing field name definitions";
        }
        
        if (!frameDefs["P"] || !frameDefs["P"].encoding || !frameDefs["P"].predictor) {
            throw "Log is missing required definitions for P frames, header may be corrupt";
        }
        if (!frameDefs["I"] || !frameDefs["I"].encoding || !frameDefs["I"].predictor) {
            throw "Log is missing required definitions for I frames, header may be corrupt";
        }
        
        // Now we know our field counts, we can allocate arrays to hold parsed data
        mainHistoryRing = [new Array(this.mainFieldCount), new Array(this.mainFieldCount), new Array(this.mainFieldCount)];
        gpsHomeHistory = [new Array(this.gpsHomeFieldCount), new Array(this.gpsHomeFieldCount)];
        lastGPS = new Array(this.gpsFieldCount);
        
        /* Home coord predictors appear in pairs (lat/lon), but the predictor ID is the same for both. It's easier to
         * apply the right predictor during parsing if we rewrite the predictor ID for the second half of the pair here:
         */
        for (var i = 1; i < that.gpsFieldCount; i++) {
            if (frameDefs['G'].predictor[i - 1] == FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD &&
                    frameDefs['G'].predictor[i] == FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD) {
                frameDefs['G'].predictor[i] = FLIGHT_LOG_FIELD_PREDICTOR_HOME_COORD_1;
            }
        }
    };
    
    this.parseLogData = function(raw, startOffset, endOffset) {
        var 
            looksLikeFrameCompleted = false,
            prematureEof = false,
            frameStart = 0,
            frameType = null,
            lastFrameType = null;

        invalidateMainStream();
        
        lastSkippedFrames = 0;
        lastMainFrameIteration = -1;
        lastMainFrameTime = -1;
        
        lastEvent = null;

        //Set parsing ranges up for the log the caller selected
        stream.start = startOffset === undefined ? stream.pos : startOffset;
        stream.pos = stream.start;
        stream.end = endOffset === undefined ? stream.end : endOffset;
        stream.eof = false;

        while (true) {
            var command = stream.readChar();

            if (lastFrameType) {
                var 
                    lastFrameSize = stream.pos - frameStart,
                    frameTypeStats;

                // Is this the beginning of a new frame?
                looksLikeFrameCompleted = getFrameType(command) || (!prematureEof && command == EOF);

                if (!this.stats.frame[lastFrameType.marker]) {
                    this.stats.frame[lastFrameType.marker] = {
                        bytes: 0,
                        sizeCount: new Int32Array(256), /* int32 arrays are zero-filled, handy! */
                        validCount: 0,
                        corruptCount: 0
                    };
                }
                
                frameTypeStats = this.stats.frame[lastFrameType.marker];
                
                // If we see what looks like the beginning of a new frame, assume that the previous frame was valid:
                if (lastFrameSize <= FLIGHT_LOG_MAX_FRAME_LENGTH && looksLikeFrameCompleted) {
                    var frameAccepted = true;
                    
                    if (lastFrameType.complete)
                        frameAccepted = lastFrameType.complete(lastFrameType.marker, frameStart, stream.pos, raw);
                    
                    if (frameAccepted) {
                        //Update statistics for this frame type
                        frameTypeStats.bytes += lastFrameSize;
                        frameTypeStats.sizeCount[lastFrameSize]++;
                        frameTypeStats.validCount++;
                    } else {
                        frameTypeStats.desyncCount++;
                    }
                } else {
                    //The previous frame was corrupt

                    //We need to resynchronise before we can deliver another main frame:
                    mainStreamIsValid = false;
                    frameTypeStats.corruptCount++;
                    this.stats.totalCorruptFrames++;

                    //Let the caller know there was a corrupt frame (don't give them a pointer to the frame data because it is totally worthless)
                    if (this.onFrameReady)
                        this.onFrameReady(false, null, lastFrameType.marker, frameStart, lastFrameSize);

                    /*
                     * Start the search for a frame beginning after the first byte of the previous corrupt frame.
                     * This way we can find the start of the next frame after the corrupt frame if the corrupt frame
                     * was truncated.
                     */
                    stream.pos = frameStart + 1;
                    lastFrameType = null;
                    prematureEof = false;
                    stream.eof = false;
                    continue;
                }
            }

            if (command == EOF)
                break;

            frameType = getFrameType(command);
            frameStart = stream.pos - 1;

            if (frameType) {
                frameType.parse(raw);
            } else {
                mainStreamIsValid = false;
            }

            //We shouldn't read an EOF during reading a frame (that'd imply the frame was truncated)
            if (stream.eof)
                prematureEof = true;

            lastFrameType = frameType;
        }
        
        this.stats.totalBytes += stream.end - stream.start;

        return true;
    };
    
    frameTypes = {
        "I": {marker: "I", parse: parseIntraframe,   complete: completeIntraframe},
        "P": {marker: "P", parse: parseInterframe,   complete: completeInterframe},
        "G": {marker: "G", parse: parseGPSFrame,     complete: completeGPSFrame},
        "H": {marker: "H", parse: parseGPSHomeFrame, complete: completeGPSHomeFrame},
        "E": {marker: "E", parse: parseEventFrame,   complete: completeEventFrame}
    };
    
    stream = new ArrayDataStream(logData);
};

FlightLogParser.prototype.resetStats = function() {
    this.stats = {
        totalBytes: 0,

        // Number of frames that failed to decode:
        totalCorruptFrames: 0,

        //If our sampling rate is less than 1, we won't log every loop iteration, and that is accounted for here:
        intentionallyAbsentIterations: 0,

        // Statistics for each field (min/max)
        field: new Array(256),
        // Statistics for each frame type ("I", "P" etc) 
        frame: {}
    };
}

FlightLogParser.prototype.FLIGHT_LOG_START_MARKER = asciiStringToByteArray("H Product:Blackbox flight data recorder by Nicholas Sherlock\n");

FlightLogParser.prototype.FLIGHT_LOG_FIELD_UNSIGNED = 0;
FlightLogParser.prototype.FLIGHT_LOG_FIELD_SIGNED   = 1;

FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_ITERATION = 0;
FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME = 1;