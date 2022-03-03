import { Component, OnInit, OnDestroy, ElementRef, ViewChild, ApplicationRef, TemplateRef } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { StorageService } from '../storage.service';
import { ImageGcp, GCP } from '../gcps-utils.service';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'

import * as rfdc from 'rfdc';
import * as proj4 from 'proj4';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { GcpsDetectorService } from '../gcps-detector.service';
import { CoordsXY, CoordsXYZ, GPSCoords } from '../../shared/common';
import { getDistanceFromLatLonInM, toHumanDistance } from 'src/shared/utils';

const clone = rfdc();

@Component({
    selector: 'app-images-tagger',
    templateUrl: './images-tagger.component.html',
    styleUrls: ['./images-tagger.component.scss']
})
export class ImagesTaggerComponent implements OnInit, OnDestroy {

    public gcp: GCP;
    public gcpCoords: CoordsXYZ;
    public errors: string[] = [];

    public isLoading = false;
    public loadingMessage = null;
    public loadingProgress: number = 0;
    public allowProgressClose: boolean = false;

    // We could save this on local storage, but it's not necessary
    public filterDistance: number = 10;

    public images: ImageDescriptor[] = [];
    public rawImages: ImageDescriptor[] = [];

    @ViewChild('dnd') dnd: ElementRef;
    private handleDrop = null;

    @ViewChild('imagesUpload') imagesUpload: ElementRef;

    constructor(private router: Router,
        private route: ActivatedRoute,
        private storage: StorageService,
        private sanitizer: DomSanitizer,
        private appRef: ApplicationRef,
        private modalService: NgbModal,
        private detector: GcpsDetectorService) {

        if (typeof storage.gcps === 'undefined' ||
            storage.gcps === null ||
            storage.gcps.length === 0 ||
            typeof storage.projection === 'undefined' ||
            storage.projection === null) {

            router.navigateByUrl('/');
            return;
        }
    }

    ngOnDestroy(): void {
        if (this.handleDrop) window.removeEventListener("droppedFiles", this.handleDrop);
    }

    ngAfterViewInit(): void {
        this.handleDrop = e => {
            this.handleImages(e.detail.files);
        };
        window.addEventListener("droppedFiles", this.handleDrop);
    }


    ngOnInit(): void {
        const gcpName = this.route.snapshot.paramMap.get('gcp');

        if (typeof gcpName === 'undefined' || gcpName === null) {
            this.router.navigateByUrl('/');
            return;
        }

        const matches = this.storage.gcps.filter(gcp => gcp.name === gcpName);

        if (matches.length === 0) {
            console.warn('Cannot find matching GCP');
            this.router.navigateByUrl('/');
            return;
        }


        this.gcp = matches[0];

        console.log("Using projection: ", this.storage.projection);
        const prj = proj4.default.Proj(this.storage.projection.eq);

        // We need this to be able to calculate the distance
        this.gcpCoords = proj4.default.transform(
            prj,
            proj4.default.WGS84,
            [this.gcp.easting, this.gcp.northing, this.gcp.elevation]);

        console.log("GCP coords: ", this.gcpCoords);

        if (this.storage.images.length === 0)
            return;

        this.setProgress("Loading images...", 0);

        this.rawImages = this.storage.images.map(img => {

            const gcps = this.storage.imageGcps.filter(imgGcp => imgGcp.imgName === img.name);
            const res = gcps.find(item => item.gcpName === gcpName);

            if (res !== undefined) {
                return {
                    image: {
                        gcpName: this.gcp.name,
                        geoX: this.gcp.easting,
                        geoY: this.gcp.northing,
                        geoZ: this.gcp.elevation,
                        imX: res.imX,
                        imY: res.imY,
                        imgName: img.name,
                        extras: []
                    },
                    isTagged: res.imX !== 0 && res.imY !== 0,
                    pinLocation: { x: res.imX, y: res.imY },
                    imageUrl: this.storage.getImageUrl(img.name) !== null ? this.sanitizer.bypassSecurityTrustResourceUrl(this.storage.getImageUrl(img.name)) : null,
                    otherGcps: gcps.map(gcp => gcp.gcpName),
                    coords: img.getCoords(),
                    distance: null
                };
            } else {
                return {
                    image: {
                        gcpName: this.gcp.name,
                        geoX: this.gcp.easting,
                        geoY: this.gcp.northing,
                        geoZ: this.gcp.elevation,
                        imX: 0,
                        imY: 0,
                        imgName: img.name,
                        extras: []
                    },
                    isTagged: false,
                    pinLocation: null,
                    imageUrl: this.storage.getImageUrl(img.name) !== null ? this.sanitizer.bypassSecurityTrustResourceUrl(this.storage.getImageUrl(img.name)) : null,
                    otherGcps: gcps.map(gcp => gcp.gcpName),
                    coords: img.getCoords(),
                    distance: null
                };
            }

        });

        this.setProgress('Calculating distances from GCP...', 0.5);

        Promise.all(this.rawImages.map(item => item.coords)).then(coords => {
            for (let i = 0; i < coords.length; i++) {
                var coord = coords[i];
                var item = this.rawImages[i];

                if (coord) {
                    item.distance = getDistanceFromLatLonInM(this.gcpCoords.y, this.gcpCoords.x, coord.lat, coord.lng);
                    console.log(item.image.imgName, coord, "Distance: " + item.distance);
                }
            }

            this.filterImages();

            this.setProgress("Done", 1, true);

        });

    }

    public filterImages() {

        this.images = this.filterDistance ? this.rawImages
            .filter(img => img.distance == null || img.distance < this.filterDistance)
            .sort((a, b) => { return a.distance > b.distance ? 1 : -1; }) : this.rawImages;
    }

    public handleImages(files: File[]) {

        if (files.length == 0) return;

        this.setProgress("Loading images...");

        var newImages = [];

        var count = 0;

        for (const file of files) { // for multiple files
            ((f, cnt) => {
                const name = f.name;
                const type = f.type;

                this.setProgress(`Reading image ${name}`, cnt / files.length * 0.75);

                const url = (window.URL ? URL : webkitURL).createObjectURL(f);
                const imageUrl = url !== null ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null;

                // Save image
                const image = this.storage.saveImageRaw(f, url);

                const res = this.images.filter(item => item.image.imgName === name);

                // If the image is not present, we add it with the GCP coordinates
                if (res.length === 0) {

                    const descr: ImageDescriptor = {
                        image: {
                            gcpName: this.gcp.name,
                            geoX: this.gcp.easting,
                            geoY: this.gcp.northing,
                            geoZ: this.gcp.elevation,
                            imX: 0,
                            imY: 0,
                            imgName: name,
                            extras: []
                        },
                        isTagged: false,
                        pinLocation: null,
                        imageUrl: imageUrl,
                        otherGcps: [],
                        coords: image.getCoords(),
                        distance: null
                    };

                    newImages.push(descr);
                    // Otherwise we add the loaded data to the array
                } else {
                    res[0].imageUrl = imageUrl;
                }

            })(file, count++);
        }

        this.rawImages = this.rawImages.concat(newImages);

        this.setProgress("Reading coordinates...", 0.75);

        Promise.all(this.rawImages.map(item => item.coords)).then(coords => {
            for (let i = 0; i < coords.length; i++) {
                var coord = coords[i];
                var item = this.rawImages[i];

                if (coord) {
                    item.distance = getDistanceFromLatLonInM(this.gcpCoords.y, this.gcpCoords.x, coord.lat, coord.lng);
                    console.log(item.image.imgName, coord, "Distance: " + item.distance);
                }
            }

            this.filterImages();

            // Notify smart images that pins might have to be refreshed
            window.dispatchEvent(new CustomEvent('smartImagesLayoutChanged'));

            this.setProgress("Done", 1, true);

        });

    }

    public imagesSelected(event) {

        const files: File[] = event.target.files;

        if (typeof files === 'undefined') {
            return;
        }

        return this.handleImages(files);
    }

    public ok(): void {

        // Save in storage
        const tmp = this.storage.imageGcps.filter(img => img.gcpName !== this.gcp.name);

        tmp.push(...this.images.filter(item => item.isTagged).map(itm => itm.image));

        this.storage.imageGcps = tmp;

        // Then go back
        this.back();
    }

    public back(): void {
        // Go back to GPCs map
        this.router.navigateByUrl('gcps-map');
    }

    public pin(location: CoordsXY, desc: ImageDescriptor): void {
        desc.isTagged = true;
        desc.image.imX = location.x;
        desc.image.imY = location.y;
    }

    public remove(desc: ImageDescriptor) {

        let internal_remove = () => {
            this.images = this.images.filter(item => item.image.imgName !== desc.image.imgName);
            this.rawImages = this.rawImages.filter(item => item.image.imgName !== desc.image.imgName);
            this.storage.removeImage(desc.image.imgName);

            // Notify smart images that pins might have to be refreshed
            window.dispatchEvent(new CustomEvent('smartImagesLayoutChanged'));
        };

        if (desc.otherGcps.length > 0) {

            const modalRef = this.modalService.open(ConfirmDialogComponent, { ariaLabelledBy: 'modal-basic-title' });

            modalRef.componentInstance.title = "Remove image";
            modalRef.componentInstance.text = "This image is associated with other GCPs. Do you want to remove it from the list?";
            modalRef.result.then((result) => {
                if (result === 'yes') internal_remove();
            });

        } else {
            internal_remove();
        }

    }

    public getClass(desc: ImageDescriptor) {

        let cls = null;

        if (desc.imageUrl !== null) {
            if (desc.isTagged) {
                cls = 'badge-success';
            } else {
                if (desc.otherGcps.length !== 0) {
                    cls = 'badge-primary';
                } else {
                    cls = 'badge-info';
                }
            }
        } else {
            cls = 'badge-warning';
        }

        var obj = {};
        obj[cls] = true;
        return obj;
    }

    public getName(desc: ImageDescriptor) {

        let name = desc.image.imgName;

        if (desc.otherGcps.length !== 0)
            name = name + ' (' + desc.otherGcps.join(', ') + ')';

        if (desc.distance)
            name = name + ' (' + toHumanDistance(desc.distance) + ')';

        return name;
    }

    public detect(desc: ImageDescriptor) {

        this.setProgress("Detecting GCPs in " + desc.image.imgName);

        this.detector.detect(desc.image.imgName).then(coords => {

            if (coords != null) {

                this.setProgress("GCP found", 1, true);

                this.pin(coords, desc);
                desc.pinLocation = coords;
            } else {
                this.setProgress("No GCP found", 1, true);
            }

        }, err => {
            console.log(err);
            this.setProgress("Error: " + err, 1, true);
        });
    }

    public async detectImages() {

        this.setProgress("Detecting GCPs in images", 0, false, true);

        for (let i = 0; i < this.images.length; i++) {

            let item = this.images[i];
            let progress = i / this.images.length;

            if (this.requestedInterrupt) {
                console.warn("Received interrupt signal");
                this.setProgress("Interrupted", progress, true, false);
                this.requestedInterrupt = false;
                return;
            }

            this.setProgress("Detecting GCPs in " + item.image.imgName + " (" + (i + 1) + "/" + this.images.length + ")", progress, false, true);
            const coords = await this.detector.detect(item.image.imgName);

            if (coords != null) {

                this.setProgress("GCP found", progress);

                this.pin(coords, item);
                item.pinLocation = coords;
            } else {
                this.setProgress("No GCP found", progress);
            }

        }

        this.setProgress("Done", 1, true);

    }

    public requestedInterrupt: boolean = false;

    public interrupt() {
        this.requestedInterrupt = true;
        this.loadingMessage = "Interrupting...";
        this.allowProgressClose = false;
    }

    private setProgress(text: string, progress: number = 0, close: boolean = false, allowClose: boolean = false) {

        console.log(text, progress, close);

        this.allowProgressClose = allowClose;
        this.loadingProgress = progress;
        this.loadingMessage = text;
        this.isLoading = true;

        if (close) {
            setTimeout(() => {
                this.isLoading = false;
                this.loadingProgress = 0;
                this.loadingMessage = null;
            }, 500);
        }
    }

}

class ImageDescriptor {
    public image: ImageGcp;
    public isTagged: boolean;
    public pinLocation: CoordsXY;
    public imageUrl: SafeResourceUrl;
    public otherGcps: string[];
    public coords: Promise<GPSCoords>;
    public distance: number;
}

